<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# NH-RAG Memory Engine

A biomimetic, three-tier memory architecture for AI agents based on the Neuro-Hierarchical RAG (NH-RAG) paper.

## Architecture

| Tier | Database | Purpose |
|------|----------|---------|
| **STM** (Short-Term Memory) | PostgreSQL | Episodic buffer — raw conversational logs, deterministic temporal recall |
| **MTM** (Medium-Term Memory) | Neo4j + GDS | Associative graph — vector-similarity edges, PageRank pruning, Louvain clustering |
| **LTM** (Long-Term Memory) | PostgreSQL + pgvector | Semantic neocortex — distilled facts with HNSW vector search |

## Prerequisites

- **Node.js** ≥ 18
- **Docker** & **Docker Compose**

## Setup

1. **Start databases:**
   ```bash
   docker-compose up -d
   ```
   This launches PostgreSQL (with pgvector) on port 5432 and Neo4j (with GDS) on port 7474/7687.

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

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/stm/log` | Log an episodic memory to STM |
| GET | `/api/stm/context/:sessionId` | Get recent conversational context |
| POST | `/api/mtm/consolidate` | Consolidate an interaction into the MTM graph |
| POST | `/api/consolidation/sleep-cycle` | Run the full sleep-cycle (prune + distill + store) |
| GET | `/api/ltm/search?q=...` | Semantic search over long-term memory |
| GET | `/api/memory/stats` | Memory tier statistics |
| GET | `/api/health` | Service health check |

## Embedding Providers

Set `EMBEDDING_PROVIDER` in your `.env.local`:
- `gemini` (default) — Google Gemini `gemini-embedding-2-preview`
- `openai` — OpenAI `text-embedding-3-small` (768D)
