DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'job_status'
  ) THEN
    CREATE TYPE job_status AS ENUM ('queued', 'running', 'completed', 'failed');
  END IF;
END $$;

ALTER TABLE short_term_memory
  DROP CONSTRAINT IF EXISTS short_term_memory_actor_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'short_term_memory_actor_check'
      AND conrelid = 'short_term_memory'::regclass
  ) THEN
    ALTER TABLE short_term_memory
      ADD CONSTRAINT short_term_memory_actor_check
      CHECK (actor IN ('user', 'agent', 'system', 'document'));
  END IF;
END $$;

ALTER TABLE short_term_memory
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'conversation',
  ADD COLUMN IF NOT EXISTS document_id UUID,
  ADD COLUMN IF NOT EXISTS chunk_id UUID,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_stm_document_id
  ON short_term_memory (document_id);

CREATE TABLE IF NOT EXISTS documents (
  document_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  filename           TEXT        NOT NULL,
  mime_type          TEXT        NOT NULL,
  checksum           TEXT        NOT NULL,
  file_size_bytes    INTEGER     NOT NULL,
  parser_name        TEXT        NOT NULL DEFAULT 'docling',
  import_status      job_status  NOT NULL DEFAULT 'queued',
  import_source      TEXT        NOT NULL DEFAULT 'upload',
  summary            TEXT,
  page_count         INTEGER,
  chunk_count        INTEGER     NOT NULL DEFAULT 0,
  last_error         TEXT,
  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_checksum
  ON documents (checksum);

CREATE TABLE IF NOT EXISTS document_chunks (
  chunk_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id        UUID        NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  chunk_index        INTEGER     NOT NULL,
  section_label      TEXT,
  page_range         TEXT,
  content_markdown   TEXT        NOT NULL,
  content_text       TEXT        NOT NULL,
  token_estimate     INTEGER     NOT NULL DEFAULT 0,
  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id
  ON document_chunks (document_id, chunk_index);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  job_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id        UUID REFERENCES documents(document_id) ON DELETE CASCADE,
  job_type           TEXT        NOT NULL,
  status             job_status  NOT NULL DEFAULT 'queued',
  stage              TEXT        NOT NULL,
  progress           INTEGER     NOT NULL DEFAULT 0,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  error_message      TEXT,
  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_document_id
  ON ingestion_jobs (document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_events (
  event_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id             UUID        REFERENCES ingestion_jobs(job_id) ON DELETE CASCADE,
  document_id        UUID        REFERENCES documents(document_id) ON DELETE CASCADE,
  stage              TEXT        NOT NULL,
  level              TEXT        NOT NULL DEFAULT 'info',
  message            TEXT        NOT NULL,
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_job_id
  ON pipeline_events (job_id, created_at DESC);

ALTER TABLE long_term_memory
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;