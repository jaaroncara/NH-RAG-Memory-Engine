import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { longTermMemory } from "../db/schema.js";
import { getProvider } from "../providers/index.js";

export interface EmbeddingSummary {
  dimensions: number;
  checksum: string;
}

export interface SemanticFact {
  knowledgeId: string;
  distilledFact: string;
  embedding: number[];
  embeddingSummary: EmbeddingSummary;
  lastAccessed: string;
  provenance: string[];
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface LtmExplorerResult {
  facts: SemanticFact[];
  total: number;
}

function parseEmbeddingText(rawEmbedding: unknown): number[] {
  if (typeof rawEmbedding !== "string") {
    return [];
  }

  const trimmed = rawEmbedding.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return [];
  }

  return body
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function summarizeEmbedding(rawEmbedding: unknown): EmbeddingSummary {
  const values = parseEmbeddingText(rawEmbedding);
  const canonical = values.map((value) => value.toExponential(12)).join(",");

  return {
    dimensions: values.length,
    checksum: createHash("sha256").update(canonical).digest("hex"),
  };
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(String(value)).toISOString();
}

function toSemanticFact(row: Record<string, unknown>): SemanticFact {
  return {
    knowledgeId: String(row.knowledge_id ?? ""),
    distilledFact: String(row.distilled_fact ?? ""),
    embedding: [],
    embeddingSummary: summarizeEmbedding(row.embedding_text),
    lastAccessed: toIsoString(row.last_accessed),
    provenance: Array.isArray(row.provenance) ? row.provenance.map((value) => String(value)) : [],
    score: row.score == null ? undefined : Number(row.score),
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : undefined,
  };
}

export async function searchLTM(
  queryText: string,
  limitCount: number = 3
): Promise<SemanticFact[]> {
  const provider = getProvider();
  const queryEmbedding = await provider.embed(queryText);
  const vecLiteral = `[${queryEmbedding.join(",")}]`;

  const rows = await db.execute(sql`
    SELECT
      knowledge_id,
      distilled_fact,
      embedding::text AS embedding_text,
      last_accessed,
      provenance,
      1 - (embedding <=> ${vecLiteral}::vector) AS score
    FROM long_term_memory
    ORDER BY embedding <=> ${vecLiteral}::vector
    LIMIT ${limitCount}
  `);

  return (rows.rows as Record<string, unknown>[]).map(toSemanticFact);
}

export async function storeFact(
  distilledFact: string,
  embedding: number[],
  provenance: string[],
  metadata?: Record<string, unknown>
): Promise<string> {
  const [row] = await db
    .insert(longTermMemory)
    .values({ distilledFact, embedding, provenance, metadata: metadata ?? {} })
    .returning({ id: longTermMemory.knowledgeId });
  return row.id;
}

export async function listLtmFacts(options?: {
  page?: number;
  pageSize?: number;
}): Promise<LtmExplorerResult> {
  const page = Math.max(options?.page ?? 1, 1);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 20, 1), 100);
  const offset = (page - 1) * pageSize;
  const rows = await db.execute(sql`
    SELECT
      knowledge_id,
      distilled_fact,
      embedding::text AS embedding_text,
      last_accessed,
      provenance,
      metadata
    FROM long_term_memory
    ORDER BY last_accessed DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `);

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(longTermMemory);

  return {
    facts: (rows.rows as Record<string, unknown>[]).map(toSemanticFact),
    total: totalRow.count,
  };
}

export async function getLtmCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(longTermMemory);
  return row.count;
}
