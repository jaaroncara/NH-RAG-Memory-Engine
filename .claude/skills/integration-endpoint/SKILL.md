---
name: integration-endpoint
description: Adds a new route to the Integration API (src/server/routes/integration.ts), including Zod schema, service delegation, metadata enrichment, and MemoryService client method. Covers auth, error handling, and testing patterns for external-facing endpoints.
---

# Skill: /integration-endpoint

Adds new externally-facing API routes to `src/server/routes/integration.ts`. All integration routes are automatically protected by `integrationAuthMiddleware` (timing-safe Bearer / `x-api-key`) and mounted under the configurable path prefix (default: `/api/v1/integration`).

---

## Architecture overview

```
server.ts
  └─ app.use(getIntegrationRoutePrefix(), integrationAuthMiddleware, integrationRoutes)
                                              ↑
                              src/server/middleware/integrationAuth.ts
                              src/server/config/integration.ts (INTEGRATION_API_KEYS, INTEGRATION_BASE_PATH)
```

**Key constraint:** Integration routes must **not** expose internal service methods directly. Add a thin wrapper in the service if the existing method signature doesn't match the external contract.

---

## Auth mechanics (do not modify)

`integrationAuth.ts` accepts:
- `Authorization: Bearer <key>` header
- `x-api-key: <key>` header

If `INTEGRATION_API_KEYS` is empty, auth is **disabled** (`isIntegrationAuthEnabled()` returns false) — any request passes through. This is intentional for local dev without keys.

Uses `node:crypto timingSafeEqual` — never replace with string equality.

---

## Existing routes (as of last read)

| Method | Path | Service | Purpose |
|---|---|---|---|
| `GET` | `/health` | direct db pings | Service health + auth status |
| `POST` | `/chat-logs` | `addEpisodicLog` | Write a single episodic log entry to STM |
| `POST` | `/chat-logs/batch` | `addEpisodicLog` (loop) | Write up to 200 log entries in one call |
| `GET` | `/sessions/:sessionId/context` | `getRecentContext` | Fetch recent STM entries for a session |
| `GET` | `/ltm/search` | `searchLTM` | ANN similarity search against LTM |
| `POST` | `/retrieval/context` | `getCombinedRetrievalContext` | Combined STM context + LTM semantic search |
| `GET` | `/documents` | `listDocuments` | List ingested documents (max 100) |
| `POST` | `/documents/import` | `importUploadedDocumentsWithOptions` | Upload files for async Docling ingestion |
| `GET` | `/documents/:documentId` | `getDocumentDetail` | Full document detail + chunks + events |
| `GET` | `/jobs` | `listJobs` | List ingestion jobs (max 100) |
| `GET` | `/jobs/:jobId` | `getJob` | Single job status |
| `GET` | `/jobs/:jobId/events` | `listPipelineEvents` | Pipeline events for a job |

---

## Pre-flight: gather inputs before touching any file

| Input | Question |
|---|---|
| **Route path + method** | `GET /ltm/facts` or `POST /retrieval/something`? |
| **Request contract** | Query params (GET) or JSON body (POST)? What fields are required vs. optional? |
| **Service method** | Does a `src/server/services/*.ts` method already expose this, or does a new wrapper need to be created? |
| **Response shape** | What JSON does the caller expect? Envelope with a key (e.g., `{ facts }`) or a flat array? |
| **Auth requirement** | All integration routes are always gated — no per-route opt-out needed |
| **MemoryService client** | Does `src/lib/memoryService.ts` need a new static method for the frontend? |

---

## Step-by-step: adding a new integration route

### Step 1 — Define the Zod schema

Add a file-scoped `const` schema near the top of `integration.ts`, alongside the existing schemas:

```ts
// Example: paginated LTM facts
const ltmFactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
```

For POST bodies use `.parse(req.body)`. For GET query strings use `.parse(req.query)` with `z.coerce` on numeric fields.

---

### Step 2 — Add the route handler

Add the handler inside `integration.ts`, before the `export default router` line. Follow the existing error handling pattern exactly — use the local `handleRouteError` helper:

```ts
router.get("/ltm/facts", async (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = ltmFactsQuerySchema.parse(req.query);
    const result = await listLtmFacts(page, pageSize);
    res.json({
      page,
      pageSize,
      total: result.total,
      facts: result.facts,
    });
  } catch (error) {
    handleRouteError(res, "Integration LTM facts failed", error, "Failed to load LTM facts");
  }
});
```

**`handleRouteError` behavior:**
- `ZodError` → 400 with `{ error: error.issues }`
- Any other error → 500 with `{ error: message }` and `console.error` log

**Never** write inline `if (error instanceof z.ZodError)` checks — that's what `handleRouteError` is for.

---

### Step 3 — Import the service method

Add the import to the existing import block at the top of `integration.ts`. Use `.js` extension on relative paths:

```ts
import { listLtmFacts } from "../services/ltmService.js";
```

If the needed method does not exist in the service, create it there first. Integration routes **must not** import `db`, `pool`, or `getNeo4jDriver` directly.

---

### Step 4 — Add metadata enrichment (POST routes that write data)

When the route writes to STM or imports documents, always embed integration provenance using the existing `buildIntegrationMetadata` / `buildDocumentIntegrationMetadata` helpers inside the file:

```ts
// Reading shared fields from request body (already on sharedIntegrationSchema)
const metadata = buildIntegrationMetadata(body);
await addEpisodicLog(body.sessionId, body.actor, body.rawText, {
  sourceType: "integration_api",
  metadata,
});
```

The `buildIntegrationMetadata` function adds `ingestedVia: "integration-api"` automatically and strips `undefined` fields via `compactRecord`. Do not replicate this logic inline.

---

### Step 5 — Add a MemoryService client method (if frontend needs access)

If the new route should also be reachable from the frontend or other internal tools, add a typed static method to `src/lib/memoryService.ts`:

```ts
static async listIntegrationLtmFacts(page = 1, pageSize = 20): Promise<{ facts: SemanticFact[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const res = await fetch(`${API}/v1/integration/ltm/facts?${params.toString()}`);
  return json<{ facts: SemanticFact[]; total: number; page: number; pageSize: number }>(res);
}
```

Note: use the `API` constant (`/api`) — the integration prefix is already baked in as `/v1/integration/...`.

---

## Shared schemas

The `sharedIntegrationSchema` captures standard provenance fields that external callers can attach to any write operation:

```ts
const sharedIntegrationSchema = z.object({
  sourceApp: z.string().min(1).max(120).optional(),   // e.g., "my-chat-app"
  agentId: z.string().min(1).max(120).optional(),      // e.g., "agent-001"
  namespace: z.string().min(1).max(120).optional(),    // tenant/namespace isolation key
  externalConversationId: z.string().min(1).max(240).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
```

Extend it for new write endpoints with `.extend({...})`. For read-only endpoints, skip it.

---

## File upload routes

If the new route accepts files (like `/documents/import`), use the existing `upload` middleware configured at the top of `integration.ts`:

```ts
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 10, fileSize: 20 * 1024 * 1024 } });

router.post("/my-upload-route", upload.array("files", 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "At least one file is required" });
    return;
  }
  // ...
});
```

Do **not** create a second `multer` instance — reuse the file-scoped `upload`.

---

## Response conventions

| Situation | HTTP status | Shape |
|---|---|---|
| Successful read | 200 | Direct data or envelope object |
| Successful write (sync) | 201 | `{ accepted: true, ...ids }` |
| Successful write (async job) | 202 | `{ accepted: true, documents, jobIds }` |
| Missing required resource | 404 | `{ error: "X not found" }` |
| Validation failure | 400 | `{ error: ZodIssue[] }` (via handleRouteError) |
| Server error | 500 | `{ error: string }` (via handleRouteError) |

---

## Configuring auth for testing

**Enable auth:**
```bash
# .env.local
INTEGRATION_API_KEYS=my-local-dev-key,optional-second-key
```

**Call with curl:**
```bash
# Bearer token
curl -H "Authorization: Bearer my-local-dev-key" http://localhost:3000/api/v1/integration/health

# x-api-key header
curl -H "x-api-key: my-local-dev-key" http://localhost:3000/api/v1/integration/health
```

**Disable auth (local dev, no keys set):**
```bash
# Remove or leave blank
INTEGRATION_API_KEYS=
```

When `INTEGRATION_API_KEYS` is empty, `isIntegrationAuthEnabled()` returns `false` and the middleware calls `next()` immediately. The `/health` route also exposes `authRequired: false` in its response to make this explicit.

---

## Changing the route prefix

```bash
# .env.local
INTEGRATION_BASE_PATH=/api/v2/external
```

`getIntegrationRoutePrefix()` normalizes the value (adds leading slash, strips trailing slash). The change takes effect on server restart. All relative paths in `integration.ts` are unchanged — only the mount point moves.

---

## Completion checklist

- [ ] Zod schema defined at file scope (not inline in the handler)
- [ ] Route handler added before `export default router`
- [ ] Uses `handleRouteError` for all error paths
- [ ] Service method imported with `.js` extension
- [ ] No direct DB imports in the route (`db`, `pool`, `getNeo4jDriver`)
- [ ] POST write routes include `buildIntegrationMetadata` enrichment
- [ ] File upload routes reuse the file-scoped `upload` middleware
- [ ] 404 returned explicitly for resource-not-found cases
- [ ] MemoryService static method added if the route is needed by the frontend
- [ ] Tested with curl using both `Authorization: Bearer` and `x-api-key` headers
- [ ] Tested with auth disabled (empty `INTEGRATION_API_KEYS`)
