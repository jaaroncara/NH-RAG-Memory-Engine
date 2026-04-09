-- NH-RAG Memory Engine: PostgreSQL initialization
-- Handles STM (Short-Term Memory) and LTM (Long-Term Memory) tiers

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- STM: Short-Term Memory (Episodic Buffer)
-- Raw, un-embedded conversational logs for deterministic recall
-- ============================================================
CREATE TABLE IF NOT EXISTS short_term_memory (
  interaction_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id     TEXT        NOT NULL,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor          TEXT        NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  raw_text       TEXT        NOT NULL CHECK (LENGTH(raw_text) <= 5120)
);

CREATE INDEX IF NOT EXISTS idx_stm_session_time
  ON short_term_memory (session_id, timestamp DESC);

-- ============================================================
-- LTM: Long-Term Memory (Semantic Neocortex)
-- Distilled semantic facts with vector embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS long_term_memory (
  knowledge_id  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  distilled_fact TEXT       NOT NULL,
  embedding      vector(768) NOT NULL,
  last_accessed  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provenance     TEXT[]      DEFAULT '{}'
);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_ltm_embedding_hnsw
  ON long_term_memory
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
