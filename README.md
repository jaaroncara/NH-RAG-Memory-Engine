# NH-RAG Memory Engine

A biomimetic, three-tier memory architecture for persistent AI agents, implementing the **Neuro-Hierarchical Retrieval-Augmented Generation (NH-RAG)** framework — a system that replicates the human cognitive memory lifecycle to enable lifelong, high-fidelity agent memory.

---

## The Problem with Standard RAG

The dominant paradigm for agentic memory is flat-vector RAG: every conversational turn is chunked, embedded, and appended to a vector database indefinitely. At scale, this approach breaks down in three predictable ways:

1. **Semantic Saturation & Context Bloat** — As the vector space expands with everyday transactional logs, distinct concepts converge. Agents retrieve dozens of similar but irrelevant memory chunks, causing the "lost in the middle" phenomenon where critical information is buried in noise.

2. **Synchronous Latency** — Embedding generation is computationally expensive. Forcing embedding *before* responding to the user introduces measurable latency on every single turn.

3. **The Hoarding Fallacy** — Flat-RAG systems assume all data is equally valuable. Without a native mechanism to forget, the database fills with transient, low-signal information: typos, weather queries, filler phrases. The system cannot distinguish signal from noise.

---

## The NH-RAG Approach: Biomimetic Memory

NH-RAG solves these problems by modeling the human brain's memory architecture. Rather than a single flat database, it implements a **three-tier, metabolizing pipeline** where memory continuously flows, consolidates, and — crucially — is actively forgotten.

### Memory Tiers

| Tier | Neurological Analog | Database | Role |
|------|---------------------|----------|------|
| **STM** — Short-Term Memory | Working Memory / Episodic Buffer | PostgreSQL | Exact, un-embedded conversational logs. Zero-latency deterministic SQL recall. Volatile by design. |
| **MTM** — Medium-Term Memory | Hippocampus | Neo4j + GDS | Vector-embedded episodic nodes connected by cosine similarity edges. A topological staging ground for associative learning. |
| **LTM** — Long-Term Memory | Neocortex | PostgreSQL + pgvector | Distilled semantic facts stored as high-dimensional vectors. Timeless knowledge artifacts, not raw transcripts. |

---

## How It Works: The Memory Lifecycle

### Stage 1 — Encoding (STM)

Every conversational turn is written to the STM as a raw string literal. No embeddings are generated. This makes writes sub-millisecond and keeps the user-interaction "hot path" entirely free of heavy compute. The STM is a sliding time-series window — volatile by design. After a session ends (or a 24-hour threshold), raw logs are flagged for asynchronous promotion.

### Stage 2 — Associative Mapping (MTM)

During an asynchronous consolidation pass, STM logs are promoted to the MTM. Each log is now embedded for the first time, creating an **Episodic Node** in Neo4j. The system then calculates cosine similarity between the new node and all existing nodes, drawing weighted `SIMILAR_TO` edges where similarity exceeds a threshold (≥ 0.85).

The result is a living knowledge graph where temporally distant but semantically related events become structurally connected. An entry from Monday ("My dog Barnaby is sick") and one from Thursday ("I need a dog-friendly apartment") are linked not by time, but by shared semantic proximity — both connect to the emergent concept of *Barnaby, the dog*.

### Stage 3 — Algorithmic Forgetting (Synaptic Pruning)

Before any memory reaches the LTM, it must survive pruning. NH-RAG runs **weighted PageRank** (via Neo4j GDS) across the entire MTM graph:

$$PR(u) = (1 - d) + d \sum_{v \in B(u)} \frac{PR(v) \cdot w(v,u)}{L(v)}$$

Episodic nodes with low centrality scores — those that failed to form meaningful edges with the rest of the graph — are deemed mundane and permanently deleted (`DETACH DELETE`). The Salience Threshold ($\tau$) is dynamically set at the 25th percentile of current PageRank scores. An isolated memory is a mundane memory.

This is **Algorithmic Forgetting**: the agent permanently discards conversational noise before it can pollute the semantic knowledge store.

### Stage 4 — Sleep-Cycle Consolidation (MTM → LTM)

After pruning, Louvain Community Detection is run over the surviving graph. This partitions the nodes into dense thematic clusters — mathematically identifying emergent macro-concepts across weeks of interactions.

A cluster containing fifteen episodic nodes spanning complaints about rent, weather queries near New York, and mentions of a new job offer are not, to the algorithm, fifteen isolated facts. They are a single dense community representing *Relocation to New York*.

Each surviving community is passed to an LLM, which synthesizes the entire cluster into a single distilled statement:

> *"User is relocating to New York City for a software job, is highly sensitive to living costs, and requires accommodations that allow their dog, Barnaby."*

This artifact is embedded and stored permanently in the LTM. The originating MTM nodes are then purged. **1,500 tokens of noisy episodic logs become a 30-token precision summary.** This is the core compression gain of NH-RAG.

### Stage 5 — Cascading Retrieval

At inference time, NH-RAG uses a **parallelized, two-track retrieval strategy** rather than a single monolithic vector search:

- **Track 1 (STM — Deterministic):** A strict SQL time-series query fetches the exact verbatim transcript of the current session. The agent knows *precisely* what was just said. No semantic approximation, no temporal hallucination.

- **Track 2 (LTM — Probabilistic):** The user's prompt is embedded and used for ANN cosine search against the pgvector LTM. The agent retrieves distilled semantic truths relevant to the query — without the noise of the raw episodic history that generated them.

Both tracks are injected into the LLM's context with structural delineation, so the model inherently understands the difference between an immediate command and an established fact.

The MTM graph is reserved as an **on-demand fallback** via explicit tool use — only traversed when the agent determines that neither the STM nor the LTM contains sufficiently specific episodic detail to answer the query.

---

## Why NH-RAG is Different

| Problem | Standard RAG | NH-RAG |
|---------|-------------|--------|
| Context bloat | Injects raw episodic logs (~1,500 tokens) | Injects distilled semantic facts (~30 tokens) |
| Temporal disorientation | Vector search conflates past and present | STM tier guarantees deterministic chronological grounding |
| Synchronous latency | Embeds every turn before responding | Encoding is a raw SQL write; embedding is fully async |
| Storage scaling | Linear — $O(n)$ growth forever | Logarithmic — $O(\log n)$ via pruning + distillation |
| Conflicting facts | Both versions retrieved simultaneously | LTM conflict resolution synthesizes a reconciled truth |
| Mundane noise | Stored permanently | Pruned via PageRank before it reaches the LTM |

---

## Architecture

```
User Input
    │
    ▼
┌─────────────────────────────────┐
│  STM (PostgreSQL)               │  ← Raw text, sub-ms writes, deterministic SQL recall
│  short_term_memory table        │
└────────────────┬────────────────┘
                 │  async promotion
                 ▼
┌─────────────────────────────────┐
│  MTM (Neo4j + GDS)              │  ← Embed → EpisodicNodes → SIMILAR_TO edges
│  PageRank pruning               │  ← Salience Threshold τ (25th percentile)
│  Louvain community detection    │  ← Thematic clustering
└────────────────┬────────────────┘
                 │  LLM distillation
                 ▼
┌─────────────────────────────────┐
│  LTM (PostgreSQL + pgvector)    │  ← Distilled facts, HNSW index, cosine search
│  long_term_memory table         │
└─────────────────────────────────┘
```

---

## Prerequisites

- **Node.js** ≥ 18
- **Docker** & **Docker Compose**

---

## Setup

1. **Start databases:**
   ```bash
   docker-compose up -d
   ```
   This launches PostgreSQL 16 (with pgvector) on port 5432, Neo4j 5 Enterprise (with GDS) on ports 7474/7687, and a Docling sidecar on port 8081 for document parsing.

2. **Configure environment:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and set your `GEMINI_API_KEY` (or `OPENAI_API_KEY` if using `EMBEDDING_PROVIDER=openai`).

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Run the Postgres migration against your current database:**
   ```bash
   npm run db:migrate
   ```
   This applies tracked SQL migrations from `db/migrations` and is the correct way to upgrade an existing local Postgres volume with the new document/job/event tables.

5. **Run the app:**
   ```bash
   npm run dev:local
   ```
   Opens at [http://localhost:3000](http://localhost:3000). This single process hosts both the Express backend and the Vite-powered frontend.

## MCP Integration API

This app now exposes a dedicated integration surface for external callers such as your MCP server. The existing `/api/*` routes remain in place for the operator console and internal/debug workflows, while the new integration layer is intended to be the stable service-to-service contract.

Default base path:

```text
/api/v1/integration
```

Optional auth:

- Set `INTEGRATION_API_KEYS` to a comma-separated list of API keys.
- When configured, send either `X-API-Key: <key>` or `Authorization: Bearer <key>`.
- If `INTEGRATION_API_KEYS` is empty, integration routes are left unauthenticated for local development.

Current integration endpoints:

- `GET /api/v1/integration/health`
- `POST /api/v1/integration/chat-logs`
- `POST /api/v1/integration/chat-logs/batch`
- `GET /api/v1/integration/sessions/:sessionId/context`
- `GET /api/v1/integration/ltm/search?q=...&limit=...`
- `POST /api/v1/integration/retrieval/context`
- `GET /api/v1/integration/documents`
- `POST /api/v1/integration/documents/import`
- `GET /api/v1/integration/documents/:documentId`
- `GET /api/v1/integration/jobs`
- `GET /api/v1/integration/jobs/:jobId`
- `GET /api/v1/integration/jobs/:jobId/events`

Recommended external usage pattern:

1. Post chat turns into STM through `POST /api/v1/integration/chat-logs` or `/chat-logs/batch`.
2. Fetch memory context through `POST /api/v1/integration/retrieval/context` when your MCP tool needs both recent STM and semantic LTM in one call.
3. Upload documents through `POST /api/v1/integration/documents/import`, then poll `GET /api/v1/integration/jobs/:jobId` until completion.
4. Read final document/chunk details through `GET /api/v1/integration/documents/:documentId`.

Operator-only note:

- The raw query-console routes under `/api/query/*` are not part of the integration contract and should not be exposed to external MCP callers.

## Starting Services

### 1. Infrastructure services

The commands below can be run with either Docker or Podman. The project scripts now prefer `podman` automatically when it is installed and fall back to `docker` otherwise.

Start PostgreSQL, Neo4j, and the Docling sidecar:

```bash
podman compose up -d postgres neo4j docling
```

If you prefer to start everything defined in Compose:

```bash
podman compose up -d
```

### 2. Full stack with one command

To build and run the entire stack in containers, including the app itself:

```bash
npm run dev
```

This now runs:

```bash
podman compose up --build
```

That single command starts:

- `postgres`
- `neo4j`
- `docling`
- `app`

The `app` container automatically runs the Postgres migration before starting the server.

### 3. Local app process with containerized dependencies

If you prefer to run the Node app on your host machine while still using Docker for Postgres, Neo4j, and Docling:

```bash
npm run dev:local
```

This brings up the dependency containers and then starts the local Node/Vite app process.

### 4. Direct local server only

If your infra is already running and you only want the local app server:

```bash
npm run dev:server
```

This project does **not** run separate frontend and backend dev commands. The Node server in [server.ts](server.ts) mounts Vite middleware, so the React frontend is served from the same process on port `3000`.

### 3. Optional migration step for existing databases

If your Postgres volume already existed before the operator-console changes, run:

```bash
npm run db:migrate
```

You only need to run it again when new SQL files are added under `db/migrations`.

## Recommended Local Startup Order

1. Copy the environment file:
   ```bash
   cp .env.example .env.local
   ```

2. Edit `.env.local` and set the provider credentials you actually use:
   - `GEMINI_API_KEY` if `EMBEDDING_PROVIDER=gemini`
   - `OPENAI_API_KEY` if `EMBEDDING_PROVIDER=openai`

3. Start infrastructure:
   ```bash
   podman compose up -d postgres neo4j docling
   ```

4. Install Node dependencies:
   ```bash
   npm install
   ```

5. Run the database migration:
   ```bash
   npm run db:migrate
   ```

6. Start the app server and frontend:
   ```bash
   npm run dev:local
   ```

7. Open the operator console:
   ```text
   http://localhost:3000
   ```

## Verifying That Everything Is Running

- Backend + frontend: open `http://localhost:3000`
- Health endpoint: open `http://localhost:3000/api/health`
- Docling sidecar: open `http://localhost:8081/health`
- Neo4j Browser: open `http://localhost:7474`

If `npm run db:migrate` fails, verify that:

- PostgreSQL is reachable on the `DATABASE_URL` in `.env.local`
- the `vector` extension exists in your Postgres container
- you are running the command from the project root

## Podman Notes

- `npm run dev` and `npm run dev:local` now prefer Podman automatically.
- If both Podman and Docker are installed, the scripts choose `podman` first.
- You can still run Compose manually with `podman compose ...` if you want direct control.
- To stop the stack from the project root, run:

```bash
npm run infra:down
```

## Command Summary

- Full containerized stack: `npm run dev`
- Local app + containerized infra: `npm run dev:local`
- Local app only: `npm run dev:server`
- Run tracked Postgres migrations: `npm run db:migrate`

## Operator Console

The frontend now behaves as a database-oriented control plane rather than a message composer. The primary surfaces are:

- **Documents:** upload one or more files, inspect chunk extraction, and trace import events.
- **STM:** paginated PostgreSQL view of raw episodic rows, including document-derived chunks.
- **MTM Graph:** Neo4j subgraph explorer for recent episodic nodes and similarity edges.
- **LTM:** pgvector-backed distilled fact store.
- **Jobs:** ingestion and sleep-cycle execution timeline.

If the Docling sidecar is not running, plain-text and Markdown files still import via a local fallback parser, but richer formats require Docling.

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/stm/log` | Write a raw episodic turn to the STM |
| `GET` | `/api/stm/context/:sessionId` | Fetch recent verbatim context for a session |
| `GET` | `/api/stm/entries` | Paginated STM table explorer |
| `GET` | `/api/documents` | List imported documents |
| `POST` | `/api/documents/import` | Upload and ingest one or more documents through Docling |
| `GET` | `/api/documents/:documentId` | Get chunk detail and event lineage for a document |
| `POST` | `/api/mtm/consolidate` | Embed an interaction and add it as a node in the MTM graph |
| `GET` | `/api/mtm/graph` | Fetch a bounded Neo4j subgraph snapshot for visualization |
| `POST` | `/api/consolidation/sleep-cycle` | Run the full sleep-cycle: PageRank pruning → Louvain clustering → LLM distillation → LTM storage |
| `GET` | `/api/ltm/search?q=...` | ANN cosine search over distilled long-term facts |
| `GET` | `/api/ltm/facts` | Paginated LTM fact explorer |
| `GET` | `/api/jobs` | List ingestion and consolidation jobs |
| `GET` | `/api/jobs/events` | List pipeline events across jobs/documents |
| `GET` | `/api/metrics/overview` | Operator dashboard metrics and recent activity |
| `GET` | `/api/memory/stats` | Row/node counts across all three memory tiers |
| `GET` | `/api/health` | Database connectivity health check |

---

## Embedding Providers

Set `EMBEDDING_PROVIDER` in your `.env.local`:

| Value | Model | Dimensions |
|-------|-------|------------|
| `gemini` (default) | `gemini-embedding-2-preview` | 768 |
| `openai` | `text-embedding-3-small` | 768 |

API keys are server-side only and never exposed to the client bundle.
