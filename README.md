<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

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
   This launches PostgreSQL 16 (with pgvector) on port 5432 and Neo4j 5 Enterprise (with GDS) on ports 7474/7687.

2. **Configure environment:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and set your `GEMINI_API_KEY` (or `OPENAI_API_KEY` if using `EMBEDDING_PROVIDER=openai`).

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Run the app:**
   ```bash
   npm run dev
   ```
   Opens at [http://localhost:3000](http://localhost:3000).

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/stm/log` | Write a raw episodic turn to the STM |
| `GET` | `/api/stm/context/:sessionId` | Fetch recent verbatim context for a session |
| `POST` | `/api/mtm/consolidate` | Embed an interaction and add it as a node in the MTM graph |
| `POST` | `/api/consolidation/sleep-cycle` | Run the full sleep-cycle: PageRank pruning → Louvain clustering → LLM distillation → LTM storage |
| `GET` | `/api/ltm/search?q=...` | ANN cosine search over distilled long-term facts |
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
