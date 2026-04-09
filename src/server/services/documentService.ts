import crypto from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { documentChunks, documents, ingestionJobs } from "../db/schema.js";
import { chunkParsedDocument, parseDocumentWithDocling } from "./doclingService.js";
import { createJob, listPipelineEvents, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";
import { consolidateToMTM } from "./mtmService.js";
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

export async function importUploadedDocuments(files: Express.Multer.File[]) {
  const imported: DocumentRecord[] = [];

  for (const file of files) {
    const checksum = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const existing = await db
      .select()
      .from(documents)
      .where(eq(documents.checksum, checksum))
      .limit(1);

    if (existing[0]) {
      imported.push(toDocumentRecord(existing[0]));
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

    try {
      await markJobRunning(jobId, "parsing", 15);
      await db
        .update(documents)
        .set({ importStatus: "running", updatedAt: new Date() })
        .where(eq(documents.documentId, document.documentId));

      const parsed = await parseDocumentWithDocling(file);
      await recordPipelineEvent({
        jobId,
        documentId: document.documentId,
        stage: "parsing",
        message: `Parsed ${file.originalname} with ${parsed.parserName}`,
        payload: { sections: parsed.sections.length },
      });

      const chunks = chunkParsedDocument(parsed);
      const insertedChunks = await db
        .insert(documentChunks)
        .values(
          chunks.map((chunk, chunkIndex) => ({
            documentId: document.documentId,
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

      await markJobRunning(jobId, "writing_stm", 40);
      const interactionIds = await addDocumentChunksToSTM(
        document.documentId,
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
        documentId: document.documentId,
        stage: "writing_stm",
        message: "Inserted document chunks into STM",
        payload: { chunkCount: insertedChunks.length },
      });

      await markJobRunning(jobId, "promoting_mtm", 65);
      for (let index = 0; index < interactionIds.length; index += 1) {
        await consolidateToMTM(interactionIds[index], insertedChunks[index].contentText);
      }

      await recordPipelineEvent({
        jobId,
        documentId: document.documentId,
        stage: "promoting_mtm",
        message: "Promoted STM chunks into MTM graph",
        payload: { promotedChunks: interactionIds.length },
      });

      await db
        .update(documents)
        .set({
          parserName: parsed.parserName,
          importStatus: "completed",
          summary: parsed.summary ?? null,
          pageCount: parsed.pageCount ?? null,
          chunkCount: insertedChunks.length,
          updatedAt: new Date(),
          metadata: {
            parserName: parsed.parserName,
            sections: parsed.sections.length,
          },
        })
        .where(eq(documents.documentId, document.documentId));

      await markJobCompleted(jobId, "completed", 100, {
        chunkCount: insertedChunks.length,
      });
      await recordPipelineEvent({
        jobId,
        documentId: document.documentId,
        stage: "completed",
        message: "Document import completed",
      });

      const [stored] = await db
        .select()
        .from(documents)
        .where(eq(documents.documentId, document.documentId))
        .limit(1);
      imported.push(toDocumentRecord(stored));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(documents)
        .set({
          importStatus: "failed",
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(documents.documentId, document.documentId));
      await markJobFailed(jobId, "failed", message);
      await recordPipelineEvent({
        jobId,
        documentId: document.documentId,
        stage: "failed",
        level: "error",
        message: "Document import failed",
        payload: { error: message },
      });

      const [stored] = await db
        .select()
        .from(documents)
        .where(eq(documents.documentId, document.documentId))
        .limit(1);
      imported.push(toDocumentRecord(stored));
    }
  }

  return imported;
}

export async function listDocuments(options?: { limit?: number }) {
  const rows = await db
    .select()
    .from(documents)
    .orderBy(desc(documents.createdAt))
    .limit(options?.limit ?? 50);

  return rows.map(toDocumentRecord);
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

  return {
    ...toDocumentRecord(document),
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

function toDocumentRecord(row: typeof documents.$inferSelect): DocumentRecord {
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
  };
}