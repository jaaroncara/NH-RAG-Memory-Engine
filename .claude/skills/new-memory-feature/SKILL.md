---
name: new-memory-feature
description: Scaffolds a full vertical slice — service file, route file, memoryService.ts types/methods, and server.ts registration — following the exact patterns in this codebase. Covers STM (PostgreSQL/Drizzle), MTM (Neo4j), and LTM (pgvector) storage tiers.
---

# Skill: /new-memory-feature

Scaffolds a complete vertical slice for a new memory-tier feature — service, route, `memoryService.ts` types/methods, and `server.ts` registration — following the exact patterns in this codebase.

---

## When to use this skill

Invoke `/new-memory-feature` when adding any new API-backed capability, whether it reads/writes STM (PostgreSQL/Drizzle), MTM (Neo4j), or LTM (pgvector), or introduces a new domain entirely (e.g., `/api/annotations`, `/api/sessions`).

---

## Pre-flight: gather inputs before generating

Ask the user (or infer from context) before writing any files:

| Input | Question |
|---|---|
| **Domain name** | What is the short noun for this feature? (e.g., `annotations`, `sessions`, `tags`) — used as the route prefix and filename base |
| **Storage tier** | STM (Drizzle/PostgreSQL), MTM (Neo4j), LTM (pgvector), or multiple? |
| **HTTP methods** | Which verbs are needed? (LIST, GET by ID, POST, DELETE) |
| **Zod schema** | What fields does a write (POST/PUT) body require? What types? |
| **Async pipeline** | Does this operation need a job + pipeline events for progress tracking? (yes for anything > ~1s) |

---

## Step-by-step execution

### Step 1 — Service file: `src/server/services/<domain>Service.ts`

**Rules:**
- Export named async functions only — no default exports, no classes
- Import DB from the shared singletons:
  - **STM/LTM (PostgreSQL):** `import { db } from "../db/index.js";`
  - **MTM (Neo4j):** `import { getNeo4jDriver } from "../db/neo4j.js";`
- Always close Neo4j sessions in a `finally` block
- Use `.js` extensions on all relative imports (ESM requirement)
- Type all function signatures and return values
- Do **not** import from routes — no circular dependencies

**PostgreSQL/Drizzle pattern:**
```ts
import { db } from "../db/index.js";
import { myTable } from "../db/schema.js";
import { desc, eq, sql } from "drizzle-orm";

export interface MyRecord {
  id: string;
  // ...
}

export async function listMyRecords(
  page: number = 1,
  pageSize: number = 20
): Promise<{ records: MyRecord[]; total: number }> {
  const rows = await db
    .select()
    .from(myTable)
    .orderBy(desc(myTable.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(myTable);

  return {
    records: rows.map((r) => ({ id: r.id /* map columns */ })),
    total: totalRow.count,
  };
}
```

**Neo4j pattern:**
```ts
import { getNeo4jDriver } from "../db/neo4j.js";

export async function queryMyGraph(): Promise<MyResult[]> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(`MATCH (n:EpisodicNode) RETURN n LIMIT 100`);
    return result.records.map((r) => /* map record */);
  } finally {
    await session.close();
  }
}
```

**pgvector ANN search pattern** (LTM, raw pool):
```ts
import { pool } from "../db/index.js";

export async function searchByEmbedding(
  embedding: number[],
  limitCount: number = 10
): Promise<MyFact[]> {
  const vector = `[${embedding.join(",")}]`;
  const { rows } = await pool.query<MyFact>(
    `SELECT *, 1 - (embedding <=> $1::vector) AS score
     FROM long_term_memory
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vector, limitCount]
  );
  return rows;
}
```

---

### Step 2 — Route file: `src/server/routes/<domain>.ts`

**Rules:**
- Import `Router` from `express` and service functions with `.js` extensions
- Define Zod schemas at file scope (not inline in handlers)
- Every handler: `try` → service call → `res.json()`, `catch` → check `z.ZodError` first (400), then generic 500
- Never perform DB access directly in route handlers — always delegate to the service
- Use `res.status(201)` for synchronous POST creates
- Use `res.status(202)` for accepted-async operations (job queued)
- Use `res.status(404).json({ error: "... not found" })` for missing resources
- Export `router` as default

```ts
import { Router } from "express";
import { z } from "zod";
import {
  listMyRecords,
  createMyRecord,
  getMyRecord,
} from "../services/<domain>Service.js";

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(255),
  // additional fields...
});

router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const result = await listMyRecords(page, pageSize);
    res.json(result);
  } catch (error) {
    console.error("<domain> list error:", error);
    res.status(500).json({ error: "Failed to list <domain> records" });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = createSchema.parse(req.body);
    const record = await createMyRecord(body);
    res.status(201).json(record);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    console.error("<domain> create error:", error);
    res.status(500).json({ error: "Failed to create <domain> record" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const record = await getMyRecord(req.params.id);
    if (!record) {
      res.status(404).json({ error: "<Domain> record not found" });
      return;
    }
    res.json(record);
  } catch (error) {
    console.error("<domain> detail error:", error);
    res.status(500).json({ error: "Failed to load <domain> record" });
  }
});

export default router;
```

---

### Step 3 — Frontend types + client: `src/lib/memoryService.ts`

**Rules:**
- Add TypeScript interfaces at the top of the file alongside existing interfaces — not inside the class
- Add static methods to the existing `MemoryService` class
- All methods use the private `json<T>()` helper — never handle HTTP status codes manually in methods
- Use `URLSearchParams` for GET query parameters
- The `API` constant is already defined as `"/api"` — use it, do not redefine

**Interface block** (add near top of file with existing interfaces):
```ts
export interface MyRecord {
  id: string;
  name: string;
  createdAt: string;
  // match exactly what the service returns
}
```

**Static methods** (add inside `MemoryService` class):
```ts
static async listMyRecords(options?: {
  page?: number;
  pageSize?: number;
}): Promise<{ records: MyRecord[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.page) params.set("page", String(options.page));
  if (options?.pageSize) params.set("pageSize", String(options.pageSize));
  const res = await fetch(`${API}/<domain>?${params.toString()}`);
  return json<{ records: MyRecord[]; total: number }>(res);
}

static async createMyRecord(payload: { name: string }): Promise<MyRecord> {
  const res = await fetch(`${API}/<domain>`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return json<MyRecord>(res);
}

static async getMyRecord(id: string): Promise<MyRecord> {
  const res = await fetch(`${API}/<domain>/${encodeURIComponent(id)}`);
  return json<MyRecord>(res);
}
```

---

### Step 4 — Register in `server.ts`

Two insertions required. Both must use `.js` extensions.

**Import block** (add with the other route imports at the top of `server.ts`):
```ts
import <domain>Routes from "./src/server/routes/<domain>.js";
```

**Mount block** (add under the `// API routes` comment alongside existing `app.use` calls):
```ts
app.use("/api/<domain>", <domain>Routes);
```

---

## Completion checklist

Run through this before marking the feature complete:

- [ ] `src/server/services/<domain>Service.ts` created
  - [ ] All functions have typed parameters and return types
  - [ ] All relative imports use `.js` extension
  - [ ] Neo4j sessions closed in `finally` (if applicable)
  - [ ] GDS named projections dropped in `finally` (if applicable)
  - [ ] No `req`/`res` references anywhere in the service
- [ ] `src/server/routes/<domain>.ts` created
  - [ ] Zod schemas defined at file scope
  - [ ] Every handler has try/catch with `z.ZodError` check before generic 500
  - [ ] Appropriate HTTP status codes used (201/202/404/400/500)
  - [ ] `router` exported as default
- [ ] `src/lib/memoryService.ts` updated
  - [ ] New interfaces added at file top level
  - [ ] New static methods added to `MemoryService` class body
  - [ ] Methods use the existing `json<T>()` helper
- [ ] `server.ts` updated
  - [ ] Import added with `.js` extension
  - [ ] Route mounted under `/api/<domain>`
- [ ] If long-running: job + pipeline events integrated
- [ ] No hardcoded credentials, connection strings, or API keys
- [ ] No SQL reading unbounded large tables without `LIMIT`

---

## Special cases

### Feature needs a Drizzle schema change
1. Add/alter the table definition in `src/server/db/schema.ts`
2. Create a new migration file in `db/migrations/` — name it `<NNN>_<description>.sql` continuing the existing numbering sequence
3. Run `npm run migrate` to apply before testing

### Feature is long-running (async pipeline)
Reference `src/server/services/consolidationService.ts` for the full pattern:
- Create a record in `ingestion_jobs` at the start
- Emit progress via `pipeline_events` at each pipeline stage
- Use `queueMicrotask` to begin async work after returning a `{ jobId, status: "queued" }` response with `202 Accepted`
- The frontend polls `/api/jobs` and `/api/jobs/events` at 1s intervals while any active job exists — no additional frontend polling logic is needed

### Feature is integration-facing (external API)
- Do **not** mount under `/api/<domain>` directly
- Add a handler in `src/server/routes/integration.ts` that calls the service
- Ensure the handler is behind `integrationAuthMiddleware` (already applied to the integration router)
- Do not log payload content, embeddings, or API keys at `info` level
