import { db } from "../db/index.js";
import { shortTermMemory } from "../db/schema.js";
import { and, desc, eq, ilike, sql } from "drizzle-orm";

export type Actor = "user" | "agent" | "system" | "document";

export interface EpisodicMemory {
  interactionId: string;
  sessionId: string;
  timestamp: string;
  actor: Actor;
  rawText: string;
  sourceType?: string;
  documentId?: string | null;
  chunkId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface StmExplorerResult {
  entries: EpisodicMemory[];
  total: number;
}

export async function addEpisodicLog(
  sessionId: string,
  actor: Actor,
  rawText: string,
  options?: {
    sourceType?: string;
    documentId?: string;
    chunkId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const [row] = await db
    .insert(shortTermMemory)
    .values({
      sessionId,
      actor,
      rawText,
      sourceType: options?.sourceType ?? "conversation",
      documentId: options?.documentId,
      chunkId: options?.chunkId,
      metadata: options?.metadata ?? {},
    })
    .returning({ id: shortTermMemory.interactionId });
  return row.id;
}

export async function addDocumentChunksToSTM(
  documentId: string,
  chunks: Array<{
    chunkId: string;
    contentText: string;
    sectionLabel?: string | null;
    pageRange?: string | null;
    tokenEstimate?: number;
  }>,
  options?: {
    batchSize?: number;
    onBatchProcessed?: (processedChunks: number, totalChunks: number) => Promise<void> | void;
  }
): Promise<string[]> {
  if (chunks.length === 0) {
    return [];
  }

  const batchSize = Math.min(Math.max(options?.batchSize ?? 10, 1), 100);
  const interactionIds: string[] = [];

  for (let index = 0; index < chunks.length; index += batchSize) {
    const batch = chunks.slice(index, index + batchSize);
    const rows = await db
      .insert(shortTermMemory)
      .values(
        batch.map((chunk) => ({
          sessionId: `document:${documentId}`,
          actor: "document" as const,
          rawText: chunk.contentText.slice(0, 5120),
          sourceType: "docling_import",
          documentId,
          chunkId: chunk.chunkId,
          metadata: {
            sectionLabel: chunk.sectionLabel ?? null,
            pageRange: chunk.pageRange ?? null,
            tokenEstimate: chunk.tokenEstimate ?? 0,
          },
        }))
      )
      .returning({ id: shortTermMemory.interactionId });

    interactionIds.push(...rows.map((row) => row.id));
    await options?.onBatchProcessed?.(Math.min(index + batch.length, chunks.length), chunks.length);
  }

  return interactionIds;
}

export async function getRecentContext(
  sessionId: string,
  limitCount: number = 10
): Promise<EpisodicMemory[]> {
  const rows = await db
    .select()
    .from(shortTermMemory)
    .where(eq(shortTermMemory.sessionId, sessionId))
    .orderBy(desc(shortTermMemory.timestamp))
    .limit(limitCount);

  return rows
    .map((r) => ({
      interactionId: r.interactionId,
      sessionId: r.sessionId,
      timestamp: r.timestamp.toISOString(),
      actor: r.actor as Actor,
      rawText: r.rawText,
      sourceType: r.sourceType,
      documentId: r.documentId,
      chunkId: r.chunkId,
      metadata: r.metadata as Record<string, unknown>,
    }))
    .reverse();
}

export async function listStmEntries(options?: {
  page?: number;
  pageSize?: number;
  actor?: Actor;
  documentId?: string;
  query?: string;
}): Promise<StmExplorerResult> {
  const page = Math.max(options?.page ?? 1, 1);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 20, 1), 100);
  const filters = [];

  if (options?.actor) {
    filters.push(eq(shortTermMemory.actor, options.actor));
  }
  if (options?.documentId) {
    filters.push(eq(shortTermMemory.documentId, options.documentId));
  }
  if (options?.query) {
    filters.push(ilike(shortTermMemory.rawText, `%${options.query}%`));
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;
  const entries = await db
    .select()
    .from(shortTermMemory)
    .where(whereClause)
    .orderBy(desc(shortTermMemory.timestamp))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shortTermMemory)
    .where(whereClause);

  return {
    entries: entries.map((entry) => ({
      interactionId: entry.interactionId,
      sessionId: entry.sessionId,
      timestamp: entry.timestamp.toISOString(),
      actor: entry.actor as Actor,
      rawText: entry.rawText,
      sourceType: entry.sourceType,
      documentId: entry.documentId,
      chunkId: entry.chunkId,
      metadata: entry.metadata as Record<string, unknown>,
    })),
    total: totalRow.count,
  };
}

export async function getStmCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shortTermMemory);
  return row.count;
}

export interface StmPruneResult {
  deletedByAge: number;
  deletedByCount: number;
}

/**
 * Delete conversation entries older than maxAgeHours.
 * Document chunks (source_type = 'docling_import') are excluded because they
 * may not yet have been consolidated into the MTM by the sleep cycle.
 */
async function pruneStmByAge(maxAgeHours: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM short_term_memory
    WHERE "timestamp" < NOW() - (${maxAgeHours} * INTERVAL '1 hour')
      AND source_type = 'conversation'
    RETURNING interaction_id
  `);
  return (result.rows as unknown[]).length;
}

/**
 * For every session that exceeds maxRowsPerSession, delete the oldest rows
 * beyond the cap. Applies to all source types including document chunks.
 */
async function pruneStmBySessionCount(maxRowsPerSession: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM short_term_memory
    WHERE interaction_id IN (
      SELECT interaction_id FROM (
        SELECT interaction_id,
               ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY "timestamp" DESC) AS rn
        FROM short_term_memory
      ) ranked
      WHERE rn > ${maxRowsPerSession}
    )
    RETURNING interaction_id
  `);
  return (result.rows as unknown[]).length;
}

/**
 * Run both STM pruning strategies in sequence (age first, then count cap).
 */
export async function pruneStm(opts?: {
  maxAgeHours?: number;
  maxRowsPerSession?: number;
}): Promise<StmPruneResult> {
  const deletedByAge = await pruneStmByAge(opts?.maxAgeHours ?? 72);
  const deletedByCount = await pruneStmBySessionCount(opts?.maxRowsPerSession ?? 200);
  return { deletedByAge, deletedByCount };
}
