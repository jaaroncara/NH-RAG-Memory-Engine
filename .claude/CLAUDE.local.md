# NH-RAG Memory Engine — Project Instructions

Project-level instructions. Override global `CLAUDE.md` where noted.

---

## Project Overview

A full-stack biomimetic RAG memory engine implementing a three-tier cognitive memory architecture:

- **STM** → PostgreSQL (`short_term_memory`): raw episodic text, no embeddings
- **MTM** → Neo4j (`EpisodicNode` / `SIMILAR_TO`): cosine + semantic similarity graph with GDS (PageRank, Louvain)
- **LTM** → PostgreSQL + pgvector (`long_term_memory`): 768-dim HNSW-indexed distilled facts

The "sleep cycle" is the consolidation pipeline: MTM graph → GDS scoring → LLM distillation → LTM write → prune low-salience MTM nodes.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite 6, Tailwind CSS v4, shadcn/ui (`base-nova`), Recharts, D3 v7 |
| Backend | Express 4, TypeScript, ESM (`"type": "module"`) |
| ORM | Drizzle ORM 0.45 + raw `pg.Pool` for pgvector queries |
| Graph DB | Neo4j 5 + Graph Data Science (GDS) plugin |
| Embeddings | Gemini (`@google/genai`) or OpenAI — switched via `EMBEDDING_PROVIDER` env var |
| Docling | Python microservice (port `8081`) for document parsing |
| Validation | Zod 4 on all API request bodies |
| Auth | `integrationAuth.ts` — timing-safe Bearer / `x-api-key` on `/api/v1/integration` |

---

## Directory Structure

```
server.ts                      # Express entry point (Vite middleware in dev)
index.html                     # Vite SPA root
src/
  App.tsx                      # React root + BrowserRouter
  main.tsx
  components/
    DatabaseConsole.tsx        # Monolithic shell: sidebar, routing, all sub-views
    MtmGraph.tsx               # D3 force-directed graph (Neo4j snapshot)
    QueryConsoleView.tsx       # SQL/Cypher execution console
  lib/
    memoryService.ts           # Static class wrapping all fetch() calls to /api/*
  server/
    routes/                    # One file per API prefix (stm, mtm, ltm, documents, jobs, etc.)
    services/                  # Business logic per domain
    db/
      neo4j.ts                 # Singleton Neo4j driver
      postgres.ts              # pg.Pool + Drizzle instance
    schema/                    # Drizzle table definitions
    providers/                 # Embedding provider abstraction (Gemini / OpenAI)
    config/
      integration.ts           # Derives integration keys/path from env
    middleware/
      integrationAuth.ts       # API key guard
    env.ts                     # dotenv loader (checks .env.local first)
components/
  ui/                          # shadcn primitive components (never edit directly)
db/
  migrations/                  # SQL migration files
  init-postgres.sql
  init-neo4j.cypher
services/
  docling/                     # Python microservice
```

---

## Frontend Conventions

### Component Architecture
- **`DatabaseConsole.tsx` is the monolithic shell** — all route views (`OverviewView`, `DocumentsView`, `StmView`, `MtmView`, `LtmView`, `JobsView`, etc.) are inner functions defined within it. When adding a new view, follow this same pattern: define the view as a function inside `DatabaseConsole.tsx` and wire it up via the `<Routes>` block.
- Route-to-component mapping lives entirely inside `DatabaseConsole.tsx` — there is no separate router file.
- State is local React only (`useState`, `useEffect`, `useTransition`). Do **not** introduce Redux, Zustand, or React Context without explicit request.
- All API calls go through `src/lib/memoryService.ts` — add typed methods there; never use raw `fetch()` directly in components.

### Styling Rules
- Dark theme only — base backgrounds use `bg-black` or `bg-neutral-950`/`bg-neutral-900`; text is `text-neutral-100`/`text-neutral-200`
- Use shadcn/ui primitives from `components/ui/` for buttons, cards, badges, inputs, scroll areas
- Use `lucide-react` for all icons
- Use `clsx` + `tailwind-merge` (via `cn()` utility) for conditional class merging
- Do not introduce new CSS files or styled-components

### Charts & Visualization
- **Area/line charts**: Recharts (`AreaChart`)
- **Graph rendering**: D3 v7 (`MtmGraph.tsx`) — force simulation, `svg` directly in JSX via `useRef`
- Prefer Recharts for time-series/metric data and D3 for relational/graph data

### shadcn/ui
- Config is `components.json` (style: `base-nova`, base color: `neutral`)
- Add new components via `npx shadcn add <component>` — they land in `components/ui/`
- Never manually edit generated shadcn files

---

## Backend Conventions

### Adding a New Route
1. Create `src/server/routes/<domain>.ts` exporting an Express `Router`
2. Mount it in `server.ts` under `/api/<domain>`
3. Validate all request bodies with Zod at the top of each handler
4. Implement business logic in a corresponding `src/server/services/<domain>Service.ts`
5. Return structured JSON errors: `{ error: string }` with appropriate HTTP status

### Service Layer
- Services own all DB/driver access — routes must not import `db`, `neo4j.ts`, or `pg` directly
- Long-running operations (document ingestion, sleep cycle) must create an `ingestion_jobs` record and emit `pipeline_events` — the frontend polls these for progress
- Async errors propagate up to route handlers; use try/catch in routes

### Database Access
- **PostgreSQL**: Use Drizzle ORM for typed queries. Fall back to raw `pg.Pool` only for pgvector ANN queries or CTEs Drizzle can't express. Import from `src/server/db/postgres.ts`
- **Neo4j**: Use the singleton driver from `src/server/db/neo4j.ts`. Always close sessions in a `finally` block
- **pgvector**: Embeddings are 768-dim normalized vectors. HNSW index uses `vector_cosine_ops`. Use the `<=>` cosine distance operator for ANN search
- **GDS projections**: Always drop named projections in `finally` blocks after use (see `consolidationService.ts`)

### Embedding Provider
- Never call Gemini/OpenAI SDK directly in services — use the abstraction in `src/server/providers/index.ts`
- Provider selected at startup via `EMBEDDING_PROVIDER` (`gemini` | `openai`)

### Integration API
- External routes live under `/api/v1/integration` (configurable via `INTEGRATION_BASE_PATH`)
- All integration routes must be gated by `integrationAuth` middleware
- Do not expose internal service methods directly to integration routes — add a dedicated wrapper method

---

## Environment Variables

Loaded by `src/server/env.ts` — checks `.env.local` first, then `.env`.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `NEO4J_URI` | Bolt URI (default `bolt://localhost:7687`) |
| `NEO4J_USER` | default `neo4j` |
| `NEO4J_PASSWORD` | required |
| `DOCLING_SERVICE_URL` | HTTP endpoint of Docling microservice |
| `EMBEDDING_PROVIDER` | `gemini` or `openai` |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | matching the provider |
| `INTEGRATION_API_KEYS` | comma-separated; empty = integration auth disabled |
| `INTEGRATION_BASE_PATH` | default `/api/v1/integration` |
| `DISABLE_HMR` | set `true` in containerized dev to suppress Vite HMR issues |

Never hardcode any of the above. Never commit `.env` or `.env.local`.

---

## TypeScript

- Target: ES2022, `moduleResolution: bundler`, `experimentalDecorators: true`
- Path alias: `@/*` → repo root (frontend and backend share the same alias)
- `"type": "module"` — ESM throughout; use `tsx` to run scripts (not `ts-node`)

---

## Dev & Build Scripts

```bash
npm run dev       # Vite + Express on port 3000 (HMR enabled)
npm run build     # tsc + vite build
npm run start     # node dist/server.js (production)
npm run migrate   # tsx scripts/migrate.ts — run pending SQL migrations
```

Docker:
```bash
docker compose up   # postgres, neo4j, docling, app
```

Drizzle schema changes require a migration file in `db/migrations/` — run `npm run migrate` after altering tables.

---

## Testing

No test framework is configured. If tests are requested, use **Vitest** (compatible with the existing Vite/ESM setup). Place test files as `*.test.ts` adjacent to source files.

---

## Security

- Zod validates all external input at route boundaries — never trust unchecked `req.body`
- Integration auth uses timing-safe comparison in `integrationAuth.ts` — never replace with simple string equality
- SQL exposed via the query console (`/api/query`) is restricted by `queryExecutionService.ts` — review allowed statement types before extending
- Do not log API keys, embeddings, or raw document content at `info` level; use `debug` or omit

---

## Common Gotchas

- `DatabaseConsole.tsx` is large by design — sub-views are co-located intentionally. Do not split without explicit request.
- The `pg.Pool` and Drizzle instance share the same `DATABASE_URL` — do not create additional pool instances in services.
- Neo4j GDS named projections must be explicitly dropped after use or they persist for the session.
- `DISABLE_HMR=true` is required in the Docker app container to prevent Vite HMR connection errors.
