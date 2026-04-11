import crypto from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { documentChunks, documents, ingestionJobs } from "../db/schema.js";
import { chunkParsedDocument, parseDocumentWithDocling } from "./doclingService.js";
import { createJob, listPipelineEvents, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";
import { consolidateToMTM, refreshMtmGraphAnalytics } from "./mtmService.js";
import { addDocumentChunksToSTM } from "./stmService.js";

export interface DocumentRecord {
  documentId: string;
  filename: string;
  mimeType: string;
  checksum: string;
  fileSizeBytes: number;
  parserName: string;
  importStatus: string;
  summary: string | null;
  pageCount: number | null;
  chunkCount: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  statusSummary: DocumentImportStatusSummary;
}

export interface DocumentImportStatusSummary {
  jobId: string | null;
  status: string;
  stage: string;
  progress: number;
  errorMessage: string | null;
  latestEventMessage: string | null;
  latestEventStage: string | null;
  latestEventLevel: string | null;
  latestEventAt: string | null;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentRecord {
  chunks: Array<{
    chunkId: string;
    chunkIndex: number;
    sectionLabel: string | null;
    pageRange: string | null;
    contentText: string;
    tokenEstimate: number;
    metadata: Record<string, unknown>;
  }>;
  events: Awaited<ReturnType<typeof listPipelineEvents>>;
}

interface QueuedDocumentImport {
  file: Express.Multer.File;
  documentId: string;
  jobId: string;
}

interface LatestJobRow {
  job_id: string;
  document_id: string;
  status: string;
  stage: string;
  progress: number;
  error_message: string | null;
  updated_at: Date | string;
}

interface LatestEventRow {
  document_id: string;
  stage: string;
  level: string;
  message: string;
  created_at: Date | string;
}

export async function importUploadedDocuments(files: Express.Multer.File[]) {
  const imported: Array<typeof documents.$inferSelect> = [];
  const queuedImports: QueuedDocumentImport[] = [];

  for (const file of files) {
    const checksum = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const existing = await db
      .select()
      .from(documents)
      .where(eq(documents.checksum, checksum))
      .limit(1);

    if (existing[0]) {
      imported.push(existing[0]);
      continue;
    }

    const [document] = await db
      .insert(documents)
      .values({
        filename: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        checksum,
        fileSizeBytes: file.size,
        metadata: {
          uploadedAt: new Date().toISOString(),
        },
      })
      .returning();

    const jobId = await createJob({
      documentId: document.documentId,
      jobType: "document_import",
      stage: "uploaded",
      metadata: { filename: file.originalname },
    });

    await recordPipelineEvent({
      jobId,
      documentId: document.documentId,
      stage: "uploaded",
      message: `Uploaded ${file.originalname}`,
      payload: { size: file.size, mimeType: file.mimetype },
    });

    imported.push(document);
    queuedImports.push({
      file,
      documentId: document.documentId,
      jobId,
    });
  }

  if (queuedImports.length > 0) {
    queueMicrotask(() => {
      void processQueuedDocumentBatch(queuedImports);
    });
  }

  return hydrateDocuments(imported);
}

async function processQueuedDocumentBatch(queuedImports: QueuedDocumentImport[]) {
  for (const queuedImport of queuedImports) {
    await processQueuedDocumentImport(queuedImport);
  }
}

async function processQueuedDocumentImport({ file, documentId, jobId }: QueuedDocumentImport) {
  let currentStage = "uploaded";

  try {
    currentStage = "parsing";
    await markJobRunning(jobId, currentStage, 15);
    await db
      .update(documents)
      .set({ importStatus: "running", updatedAt: new Date() })
      .where(eq(documents.documentId, documentId));

    const parsed = await parseDocumentWithDocling(file);
    await recordPipelineEvent({
      jobId,
      documentId,
      stage: currentStage,
      message: `Parsed ${file.originalname} with ${parsed.parserName}`,
      payload: { sections: parsed.sections.length },
    });

    const chunks = chunkParsedDocument(parsed);
    const insertedChunks = await db
      .insert(documentChunks)
      .values(
        chunks.map((chunk, chunkIndex) => ({
          documentId,
          chunkIndex,
          sectionLabel: chunk.sectionLabel,
          pageRange: chunk.pageRange,
          contentMarkdown: chunk.contentMarkdown,
          contentText: chunk.contentText,
          tokenEstimate: chunk.tokenEstimate,
          metadata: chunk.metadata,
        }))
      )
      .returning({
        chunkId: documentChunks.chunkId,
        contentText: documentChunks.contentText,
        sectionLabel: documentChunks.sectionLabel,
        pageRange: documentChunks.pageRange,
        tokenEstimate: documentChunks.tokenEstimate,
      });

    currentStage = "writing_stm";
    await markJobRunning(jobId, currentStage, 40);
    const interactionIds = await addDocumentChunksToSTM(
      documentId,
      insertedChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        contentText: chunk.contentText,
        sectionLabel: chunk.sectionLabel,
        pageRange: chunk.pageRange,
        tokenEstimate: chunk.tokenEstimate,
      }))
    );

    await recordPipelineEvent({
      jobId,
      documentId,
      stage: currentStage,
      message: "Inserted document chunks into STM",
      payload: { chunkCount: insertedChunks.length },
    });

    currentStage = "promoting_mtm";
    await markJobRunning(jobId, currentStage, 65);
    for (let index = 0; index < interactionIds.length; index += 1) {
      await consolidateToMTM(interactionIds[index], insertedChunks[index].contentText);
    }

    await recordPipelineEvent({
      jobId,
      documentId,
      stage: currentStage,
      message: "Promoted STM chunks into MTM graph",
      payload: { promotedChunks: interactionIds.length },
    });

    currentStage = "refreshing_graph";
    await markJobRunning(jobId, currentStage, 82);
    try {
      await refreshMtmGraphAnalytics();
      await recordPipelineEvent({
        jobId,
        documentId,
        stage: currentStage,
        message: "Recomputed MTM PageRank and communities across the full graph",
        payload: { promotedChunks: interactionIds.length },
      });
    } catch (error) {
      await recordPipelineEvent({
        jobId,
        documentId,
        stage: currentStage,
        level: "warning",
        message: "MTM graph analytics refresh failed after promotion",
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    await db
      .update(documents)
      .set({
        parserName: parsed.parserName,
        importStatus: "completed",
        summary: parsed.summary ?? null,
        pageCount: parsed.pageCount ?? null,
        chunkCount: insertedChunks.length,
        lastError: null,
        updatedAt: new Date(),
        metadata: {
          parserName: parsed.parserName,
          sections: parsed.sections.length,
        },
      })
      .where(eq(documents.documentId, documentId));

    await markJobCompleted(jobId, "completed", 100, {
      chunkCount: insertedChunks.length,
    });
    await recordPipelineEvent({
      jobId,
      documentId,
      stage: "completed",
      message: "Document import completed",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(documents)
      .set({
        importStatus: "failed",
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(documents.documentId, documentId));
    await markJobFailed(jobId, currentStage, message);
    await recordPipelineEvent({
      jobId,
      documentId,
      stage: currentStage,
      level: "error",
      message: "Document import failed",
      payload: { error: message },
    });
  }
}

async function hydrateDocuments(rows: Array<typeof documents.$inferSelect>): Promise<DocumentRecord[]> {
  const statusMap = await getDocumentImportStatusMap(rows);
  return rows.map((row) => toDocumentRecord(row, statusMap.get(row.documentId)));
}

async function getDocumentImportStatusMap(rows: Array<typeof documents.$inferSelect>) {
  if (rows.length === 0) {
    return new Map<string, DocumentImportStatusSummary>();
  }

  const documentIds = rows.map((row) => row.documentId);
  const documentIdsSql = sql.join(documentIds.map((documentId) => sql`${documentId}`), sql`, `);

  const [latestJobsResult, latestEventsResult] = await Promise.all([
    db.execute(sql`
      SELECT DISTINCT ON (document_id)
        job_id,
        document_id,
        status,
        stage,
        progress,
        error_message,
        updated_at
      FROM ingestion_jobs
      WHERE document_id IN (${documentIdsSql})
      ORDER BY document_id, created_at DESC
    `),
    db.execute(sql`
      SELECT DISTINCT ON (document_id)
        document_id,
        stage,
        level,
        message,
        created_at
      FROM pipeline_events
      WHERE document_id IN (${documentIdsSql})
      ORDER BY document_id, created_at DESC
    `),
  ]);

  const latestJobs = new Map<string, LatestJobRow>();
  for (const row of latestJobsResult.rows as unknown as LatestJobRow[]) {
    latestJobs.set(row.document_id, row);
  }

  const latestEvents = new Map<string, LatestEventRow>();
  for (const row of latestEventsResult.rows as unknown as LatestEventRow[]) {
    latestEvents.set(row.document_id, row);
  }

  return new Map(
    rows.map((row) => [
      row.documentId,
      buildDocumentImportStatusSummary(row, latestJobs.get(row.documentId), latestEvents.get(row.documentId)),
    ])
  );
}

function buildDocumentImportStatusSummary(
  row: typeof documents.$inferSelect,
  latestJob?: LatestJobRow,
  latestEvent?: LatestEventRow
): DocumentImportStatusSummary {
  const status = latestJob?.status ?? row.importStatus;
  const stage = latestJob?.stage ?? (status === "completed" ? "completed" : status === "failed" ? "failed" : "uploaded");
  const progress = latestJob?.progress ?? (status === "completed" ? 100 : 0);
  const updatedAt = normalizeTimestamp(latestJob?.updated_at) ?? row.updatedAt.toISOString();

  return {
    jobId: latestJob?.job_id ?? null,
    status,
    stage,
    progress,
    errorMessage: latestJob?.error_message ?? row.lastError,
    latestEventMessage: latestEvent?.message ?? null,
    latestEventStage: latestEvent?.stage ?? null,
    latestEventLevel: latestEvent?.level ?? null,
    latestEventAt: normalizeTimestamp(latestEvent?.created_at),
    updatedAt,
  };
}

function normalizeTimestamp(value: Date | string | undefined | null) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

export async function listDocuments(options?: { limit?: number }) {
  const rows = await db
    .select()
    .from(documents)
    .orderBy(desc(documents.createdAt))
    .limit(options?.limit ?? 50);

  return hydrateDocuments(rows);
}

export async function getDocumentDetail(documentId: string): Promise<DocumentDetail | null> {
  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.documentId, documentId))
    .limit(1);

  if (!document) {
    return null;
  }

  const chunks = await db
    .select()
    .from(documentChunks)
    .where(eq(documentChunks.documentId, documentId))
    .orderBy(documentChunks.chunkIndex);

  const events = await listPipelineEvents({ documentId, limit: 200 });
  const [statusSummary] = await hydrateDocuments([document]);

  return {
    ...statusSummary,
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      sectionLabel: chunk.sectionLabel,
      pageRange: chunk.pageRange,
      contentText: chunk.contentText,
      tokenEstimate: chunk.tokenEstimate,
      metadata: chunk.metadata as Record<string, unknown>,
    })),
    events,
  };
}

export async function getDocumentStats() {
  const summaryResult = await db.execute(sql`
    SELECT
      count(*)::int AS total_documents,
      coalesce(sum(chunk_count), 0)::int AS total_chunks,
      coalesce(sum(file_size_bytes), 0)::bigint AS total_bytes
    FROM documents
  `);
  const summary = (summaryResult.rows[0] ?? {}) as Record<string, unknown>;

  const jobsByStatus = await db
    .select({
      status: ingestionJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(ingestionJobs)
    .groupBy(ingestionJobs.status);

  return {
    totalDocuments: Number(summary.total_documents ?? 0),
    totalChunks: Number(summary.total_chunks ?? 0),
    totalBytes: Number(summary.total_bytes ?? 0),
    jobsByStatus: jobsByStatus.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.status] = row.count;
      return accumulator;
    }, {}),
  };
}

function toDocumentRecord(
  row: typeof documents.$inferSelect,
  statusSummary: DocumentImportStatusSummary
): DocumentRecord {
  return {
    documentId: row.documentId,
    filename: row.filename,
    mimeType: row.mimeType,
    checksum: row.checksum,
    fileSizeBytes: row.fileSizeBytes,
    parserName: row.parserName,
    importStatus: row.importStatus,
    summary: row.summary,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    lastError: row.lastError,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    statusSummary,
  };
}
