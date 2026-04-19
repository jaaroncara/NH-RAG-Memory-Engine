# MTM Pipeline Reconstruction Plan

> Based on the NH-RAG research paper. Full clean-slate rebuild of the Medium-Term Memory pipeline.

---

## Root Problems Diagnosed

| Problem | Location | Impact |
|---|---|---|
| O(n) JS cosine loop | `mtmService.ts:179-206` | Insert latency grows quadratically; all embeddings loaded into Node.js heap |
| Synchronous analytics on every insert | `mtm.ts:20-24` + `documentService.ts:~380` | Full PageRank + Louvain runs on every STM→MTM promotion |
| Single GDS projection for both PageRank + Louvain | `consolidationService.ts:133-484` | Louvain clusters contaminated by low-salience bridge nodes |
| `mergeBridgedCommunities` post-processor | `consolidationService.ts:748-806` | Contradicts Louvain's modularity objective; causes over-merged mega-communities |
| Legacy `semanticPayloadJson` fallback | `consolidationService.ts:323-385` | Dead code running on every sleep cycle; 2 extra Neo4j round-trips per community |
| Similarity threshold: 0.72 | `mtmService.ts:72` | Paper specifies ≥ 0.82 |
| No KNN step in sleep cycle | `consolidationService.ts` | SIMILARITY edges never rebuilt from global graph state; insertion-order dependent |

---

## Correct Pipeline Per Paper

### Insert Time (hot path — `consolidateToMTM`)

1. Embed content → `CREATE MemoryNode` with 5 fields only: `nodeId, memoryType, content, embedding, consolidatedAt`
2. Extract entities → `MERGE TopicNodes` → `CREATE MENTIONS` edges
3. **No SIMILARITY edges. No `refreshMtmGraphAnalytics()`.**

### Sleep Cycle (async batch — `processSleepCycleJob`)

```
Step 0   Clear all SIMILARITY edges from DB

Step 1   Project KNN graph   → MemoryNode + embedding property (no relationships)
Step 2   gds.knn.write       → writes SIMILARITY{weight=cosine} edges, threshold=0.82, topK=10
Step 3   Drop KNN graph
         Guard: if relationshipsWritten === 0, skip to Step 16

Step 4   Project analytics graph → MemoryNode + SIMILARITY{weight} UNDIRECTED
Step 5   gds.pageRank.stream → collect scores
Step 6   gds.pageRank.write  → persist pageRank property
Step 7   Compute τ (bottom 25th percentile, with guards)
         Collect nodesToPrune (scores < τ)
Step 8   Drop analytics graph

Step 9   DETACH DELETE nodesToPrune + orphaned TopicNodes

Step 10  Project Louvain graph → MemoryNode + SIMILARITY{weight} UNDIRECTED (pruned nodes now gone)
Step 11  gds.leiden.write (louvain fallback) → persist communityId
Step 12  Drop Louvain graph

Step 13  Read communities by communityId (exclude pruned nodeIds)
Step 14  Filter: communitySize >= 2  — NO mergeBridgedCommunities
Step 15  For each community: fetch MENTIONS context → LLM distill → store in pgvector

Step 16  STM prune (unchanged)
Step 17  LTM condense (unchanged)
```

---

## Exact GDS Calls

### KNN — build SIMILARITY edges (Steps 1-3)

```cypher
-- Project
CALL gds.graph.project($knnGraphName,
  { MemoryNode: { properties: ['embedding'] } },
  {}
)

-- Write edges
CALL gds.knn.write($knnGraphName, {
  nodeProperties:        ['embedding'],
  topK:                  10,
  sampleRate:            1.0,
  randomJoins:           10,
  writeRelationshipType: 'SIMILARITY',
  writeProperty:         'weight',
  similarityCutoff:      0.82,
  concurrency:           4
})
YIELD nodesCompared, relationshipsWritten

-- Drop
CALL gds.graph.drop($knnGraphName)
```

### PageRank (Steps 5-6)

```cypher
CALL gds.pageRank.stream($graphName, {
  relationshipWeightProperty: 'weight',
  dampingFactor: 0.85,
  maxIterations: 40
})
YIELD nodeId, score
RETURN gds.util.asNode(nodeId).nodeId AS graphNodeId, score
ORDER BY score ASC
```

### Salience Threshold τ — adaptive guards (Step 7)

```
MIN_NODES_FOR_PRUNING    = 8     // no pruning if graph < 8 nodes
MAX_PRUNE_FRACTION       = 0.20  // never prune > 20% per cycle
MIN_SCORE_VARIANCE_RATIO = 0.05  // skip pruning if score range < 5% of mean
SALIENCE_PERCENTILE      = 25    // bottom 25th percentile
```

### Community read after prune (Step 13) — simplified Cypher

```cypher
MATCH (n:MemoryNode)
WHERE n.communityId IS NOT NULL AND NOT n.nodeId IN $pruned
WITH n.communityId AS cid,
     collect(n.nodeId)  AS nodeIds,
     collect(n.content) AS contents
RETURN cid, nodeIds, contents
ORDER BY cid
```

---

## File-Level Change Table

| File | Action | Summary |
|---|---|---|
| `src/server/db/neo4j.ts` | Modify | Add 4 indexes: `memoryType`, `consolidatedAt`, `communityId`, `pageRank` on MemoryNode |
| `src/server/services/mtmService.ts` | Modify | Strip `consolidateToMTM` CREATE to 5 fields; delete JS cosine loop (lines 178-206); delete `cosineSimilarity()`; delete `SIMILARITY_THRESHOLD`; update `GraphNode`/`GraphEdge` interfaces; remove semantic payload fields from `getGraphSnapshot` |
| `src/server/services/consolidationService.ts` | Rewrite | Add Steps 0-3 (clear + KNN); split into 3 named graph projections; remove `mergeBridgedCommunities`; remove legacy fallback block; remove `buildCommunitySemanticContext`; update progress constants; update `finally` for 3 graph names |
| `src/server/routes/mtm.ts` | Modify | Remove `await refreshMtmGraphAnalytics()` from POST handler; add `GET /analytics/refresh`; POST returns `{ nodeId }` only |
| `src/server/services/documentService.ts` | Modify | Delete `refreshing_graph` stage block + helper functions + import; trim `DOCUMENT_IMPORT_PROGRESS` |
| `src/server/services/semanticGraphAttributes.ts` | Delete | No consumers after above changes (verify with grep before deleting) |
| `scripts/migrate-remove-semantic-payload.cypher` | New | One-time migration: remove `semanticPayloadJson` + 6 scalar array properties from MemoryNodes; remove `cosineWeight` from SIMILARITY edges |

---

## Key Invariants to Preserve

- `entityExtractionService.ts` and MENTIONS edge creation in `consolidateToMTM` are **unchanged** — entity extraction still runs at insert time; only SIMILARITY edge creation moves to sleep cycle
- STM pruning (step 16) and LTM condensation (step 17) are **unchanged**
- `refreshMtmGraphAnalytics()` in `mtmService.ts` remains for the new `GET /analytics/refresh` route; it is no longer called in any write path
- `getGraphSnapshot` must continue to function if SIMILARITY edges are empty (nodes inserted before first sleep cycle)

---

## Migration Sequence (one-time, before deploying new code)

1. Run `scripts/migrate-mtm-graph.cypher` if not already done (rename old labels/relationships)
2. Run `scripts/migrate-remove-semantic-payload.cypher` (remove legacy node properties)
3. Deploy new code
4. Trigger one manual sleep cycle via `POST /api/consolidation/sleep-cycle` — this rebuilds all SIMILARITY edges via GDS KNN from scratch
