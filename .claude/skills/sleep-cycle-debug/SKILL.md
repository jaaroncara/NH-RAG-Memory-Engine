---
name: sleep-cycle-debug
description: Diagnoses, traces, and repairs failures in the sleep-cycle consolidation pipeline. Covers every stage from GDS graph projection through PageRank, Louvain, LTM distillation, synaptic pruning, and graph cleanup.
---

# Skill: /sleep-cycle-debug

Diagnose and fix issues in the sleep-cycle pipeline. The pipeline runs asynchronously via `queueMicrotask` after the route returns 202 — all observability lives in `ingestion_jobs` and `pipeline_events`.

---

## Architecture overview

The sleep cycle is implemented in `src/server/services/consolidationService.ts`.

**Entry point:** `POST /api/consolidation/sleep-cycle` → `runSleepCycle()` creates a job record and fires `processSleepCycleJob(jobId)` off the call stack via `queueMicrotask`.

**Pipeline stages (in order):**

| Stage key | Progress % | What happens |
|---|---|---|
| `project_graph` | 8–24 | GDS named projection created from `EpisodicNode` + `SIMILAR_TO[combinedWeight]` |
| `rank_nodes` | 24–42 | PageRank streamed; bottom `SALIENCE_PERCENTILE` (25th) percentile marked for pruning; PageRank written back to nodes |
| `cluster_communities` | 42–55 | Louvain community IDs written; communities with `< MIN_COMMUNITY_SIZE` (3) nodes excluded |
| `distill_facts` | 62–92 | LLM distills each eligible community to a single fact → embeddings → LTM write via `storeFact()` |
| `cleanup` | 97–100 | Low-salience nodes `DETACH DELETE`d; GDS projection dropped |
| `completed` | 100 | `markJobCompleted` called with `{ pruned, consolidated }` |

**Early exit:** If `count(EpisodicNode) < 2`, the job jumps directly to `completed` with `pruned: 0, consolidated: 0`.

**GDS projection name:** `nhrag_sleep_${Date.now()}` — unique per run. Must be dropped in `finally`.

---

## Job state machine

```
queued → running (project_graph) → running (rank_nodes) → running (cluster_communities)
       → running (distill_facts) → running (cleanup) → completed
                                                      ↘ failed
```

All state transitions are written by:
- `markJobRunning(jobId, stage, progress)` — status = `"running"`
- `markJobCompleted(jobId, stage, 100, metadata)` — status = `"completed"`
- `markJobFailed(jobId, stage, errorMessage)` — status = `"failed"`

These are in `src/server/services/jobService.ts`.

---

## Querying pipeline state

**Get the latest sleep-cycle job:**
```sql
SELECT job_id, status, stage, progress, error_message, created_at, updated_at
FROM ingestion_jobs
WHERE job_type = 'sleep_cycle'
ORDER BY created_at DESC
LIMIT 5;
```

**Stream events for a specific job:**
```sql
SELECT stage, level, message, payload, created_at
FROM pipeline_events
WHERE job_id = '<jobId>'
ORDER BY created_at ASC;
```

**API equivalents (via MemoryService):**
```ts
// List recent jobs
const jobs = await MemoryService.listJobs(10);
const sleepJob = jobs.find(j => j.jobType === "sleep_cycle");

// Get events for a job
const events = await MemoryService.listPipelineEvents({ jobId: sleepJob.jobId });
```

---

## Common failure modes

### 1. GDS projection left dangling

**Symptom:** Next sleep cycle fails with `A graph with name 'nhrag_sleep_...' already exists`.

**Root cause:** A previous run threw before the `finally` block executed `gds.graph.drop($graphName)` — but since the graph name includes `Date.now()` this only happens if the same timestamp was somehow reused or the Node.js process crashed mid-session.

More commonly: a projection with a *different* timestamp was orphaned after a hard crash.

**Fix — drop all nhrag projections:**
```cypher
CALL gds.graph.list() YIELD graphName
WHERE graphName STARTS WITH 'nhrag_sleep_'
CALL gds.graph.drop(graphName) YIELD graphName AS dropped
RETURN dropped;
```

**Prevention:** The `finally` in `processSleepCycleJob` already handles clean shutdown. Only hard process kills bypass it.

---

### 2. Job stuck at `running` indefinitely

**Symptom:** `status = 'running'`, last `pipeline_events` entry is old, no further progress.

**Root cause:** `queueMicrotask` fired the job but the async work threw an unhandled error *before* the `catch` block could call `markJobFailed`. This can happen if the Neo4j session creation itself throws (driver not initialized).

**Diagnosis:**
```sql
-- Check if there's a matching pipeline_events error row
SELECT * FROM pipeline_events
WHERE job_id = '<jobId>' AND level = 'error'
ORDER BY created_at DESC LIMIT 1;
```

**Fix:** If confirmed stuck, manually reset:
```sql
UPDATE ingestion_jobs
SET status = 'failed', stage = 'failed', error_message = 'Manually reset — job was stuck'
WHERE job_id = '<jobId>';
```

---

### 3. Zero communities distilled

**Symptom:** Job completes with `consolidated: 0`, `eligibleCommunities: 0` in the `cluster_communities` event payload.

**Root cause options (in order of likelihood):**
- All communities have `< MIN_COMMUNITY_SIZE` (3) nodes — normal when the graph is sparse
- Louvain didn't write `communityId` back (GDS version mismatch — `writeProperty` must be supported)
- All non-pruned nodes ended up in one community

**Diagnosis query:**
```cypher
MATCH (n:EpisodicNode)
WHERE n.communityId IS NOT NULL
RETURN n.communityId AS cid, count(*) AS size
ORDER BY size DESC
LIMIT 20;
```

---

### 4. Embedding provider failure during distillation

**Symptom:** Job fails at `distill_facts` stage with a provider error (Gemini 429, OpenAI timeout, etc.).

**Root cause:** `provider.generate()` or `provider.embed()` threw. The catch block calls `markJobFailed` and re-throws.

**Check current provider:**
```bash
echo $EMBEDDING_PROVIDER   # gemini | openai
```

**What's affected by failure:**
- Communities processed before the failure: their facts are already written to LTM (partial write)
- Communities after: skipped
- MTM pruning: **did NOT run** (pruning happens after distillation loop)

**Safe to re-run:** Yes — `storeFact` in `ltmService.ts` uses a new `knowledgeId` UUID each time, so re-running creates duplicates. If needed, clean duplicates with:
```sql
-- Find duplicate facts by distilled_fact text
SELECT distilled_fact, count(*) AS n FROM long_term_memory
GROUP BY distilled_fact HAVING count(*) > 1;
```

---

### 5. Neo4j integer conversion errors

**Symptom:** `NaN` or `TypeError` errors when reading `count(n)`, `communityId`, or community sizes.

**Root cause:** Neo4j returns integers as `Integer` objects (not native JS numbers). The service uses `normalizeNeo4jNumber()` for this — if a new query is added that doesn't use it, conversions break.

**Pattern to follow:**
```ts
// Always wrap Neo4j integer results
const nodeCount = normalizeNeo4jNumber(record.get("cnt"));
const cid = normalizeNeo4jNumber(record.get("communityId"));
```

`normalizeNeo4jNumber` handles `number`, `bigint`, and Neo4j `Integer` objects with `.toNumber()`.

---

## Adding instrumentation to an existing stage

Use `recordPipelineEvent` to add visibility. Import from `jobService.ts`:

```ts
import { recordPipelineEvent } from "./jobService.js";

await recordPipelineEvent({
  jobId,
  stage: "rank_nodes",           // must match current job stage
  level: "info",                 // "info" | "warn" | "error" (default: "info")
  message: "Descriptive message visible in Jobs view",
  payload: {
    progress: SLEEP_CYCLE_PROGRESS.rankNodesComplete,
    // any structured data useful for debugging
    nodeCount,
    threshold,
  },
});
```

**Do not** use `level: "error"` for non-terminal events — it will mislead the UI. Reserve `"error"` for the `catch` block only.

---

## Adding a new pipeline stage

1. Add a `progress: <N>` entry to `SLEEP_CYCLE_PROGRESS` (keep it chronologically ordered, value between the surrounding stages)
2. Call `markJobRunning(jobId, "my_new_stage", SLEEP_CYCLE_PROGRESS.myNewStage)` at the start
3. Call `recordPipelineEvent(...)` at meaningful milestones within the stage
4. Keep the stage string consistent across `markJobRunning` and `recordPipelineEvent` calls
5. Ensure any new Neo4j session work is inside the existing `try/finally` block — do **not** open a second session
6. If the new stage creates a GDS projection, drop it in the `finally` block (not just on happy path)

---

## Modifying consolidation thresholds

| Constant | Location | Current value | Effect |
|---|---|---|---|
| `SALIENCE_PERCENTILE` | `consolidationService.ts:7` | `25` | % of nodes pruned by PageRank |
| `MIN_COMMUNITY_SIZE` | `consolidationService.ts:8` | `3` | Min nodes for LTM distillation |

These are module-level `const` — change them directly in the file. No env var override exists currently.

---

## Verification checklist after a fix

- [ ] `status = 'completed'` in `ingestion_jobs` for the test run
- [ ] `pipeline_events` shows all expected stage transitions with no `level = 'error'` rows
- [ ] `consolidated` count in the final event payload is non-zero (if graph is large enough)
- [ ] LTM fact count increased: `SELECT count(*) FROM long_term_memory;`
- [ ] Pruned nodes are gone: `MATCH (n:EpisodicNode) RETURN count(n)` should decrease
- [ ] No orphaned GDS projections: `CALL gds.graph.list() YIELD graphName RETURN graphName;`
