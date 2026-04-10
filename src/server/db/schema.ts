import {
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { EMBEDDING_DIMENSIONS } from "../embeddings.js";

// Custom pgvector type for Drizzle
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIMENSIONS})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/[\[\]]/g, "")
      .split(",")
      .map(Number);
  },
});

export const shortTermMemory = pgTable("short_term_memory", {
  interactionId: uuid("interaction_id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  rawText: text("raw_text").notNull(),
  sourceType: text("source_type").notNull().default("conversation"),
  documentId: uuid("document_id"),
  chunkId: uuid("chunk_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const documents = pgTable("documents", {
  documentId: uuid("document_id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  checksum: text("checksum").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  parserName: text("parser_name").notNull().default("docling"),
  importStatus: jobStatus("import_status").notNull().default("queued"),
  importSource: text("import_source").notNull().default("upload"),
  summary: text("summary"),
  pageCount: integer("page_count"),
  chunkCount: integer("chunk_count").notNull().default(0),
  lastError: text("last_error"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentChunks = pgTable("document_chunks", {
  chunkId: uuid("chunk_id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.documentId, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  sectionLabel: text("section_label"),
  pageRange: text("page_range"),
  contentMarkdown: text("content_markdown").notNull(),
  contentText: text("content_text").notNull(),
  tokenEstimate: integer("token_estimate").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ingestionJobs = pgTable("ingestion_jobs", {
  jobId: uuid("job_id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").references(() => documents.documentId, { onDelete: "cascade" }),
  jobType: text("job_type").notNull(),
  status: jobStatus("status").notNull().default("queued"),
  stage: text("stage").notNull(),
  progress: integer("progress").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineEvents = pgTable("pipeline_events", {
  eventId: uuid("event_id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => ingestionJobs.jobId, { onDelete: "cascade" }),
  documentId: uuid("document_id").references(() => documents.documentId, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const longTermMemory = pgTable("long_term_memory", {
  knowledgeId: uuid("knowledge_id").primaryKey().defaultRandom(),
  distilledFact: text("distilled_fact").notNull(),
  embedding: vector("embedding").notNull(),
  lastAccessed: timestamp("last_accessed", { withTimezone: true }).notNull().defaultNow(),
  provenance: text("provenance").array().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});
