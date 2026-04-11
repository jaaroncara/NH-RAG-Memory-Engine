export const KNOWLEDGE_BASE_CLEAR_CONFIRMATION = "CLEAR ALL DATA";

export const CLEAR_ALL_SQL_SNIPPET = `TRUNCATE TABLE
  pipeline_events,
  ingestion_jobs,
  document_chunks,
  documents,
  short_term_memory,
  long_term_memory
RESTART IDENTITY CASCADE`;

export const CLEAR_ALL_CYPHER_SNIPPET = `MATCH (n)
DETACH DELETE n`;
