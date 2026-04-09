import { db } from "../db/index.js";
import { longTermMemory } from "../db/schema.js";
import { desc, sql } from "drizzle-orm";
import { getProvider } from "../providers/index.js";

export interface SemanticFact {
  knowledgeId: string;
  distilledFact: string;
  embedding: number[];
  lastAccessed: string;
  provenance: string[];
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface LtmExplorerResult {
  facts: SemanticFact[];
  total: number;
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
      last_accessed,
      provenance,
      1 - (embedding <=> ${vecLiteral}::vector) AS score
    FROM long_term_memory
    ORDER BY embedding <=> ${vecLiteral}::vector
    LIMIT ${limitCount}
  `);

  return (rows.rows as any[]).map((r) => ({
    knowledgeId: r.knowledge_id,
    distilledFact: r.distilled_fact,
    embedding: [],
    lastAccessed: r.last_accessed,
    provenance: r.provenance || [],
    score: Number(r.score),
  }));
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
  const rows = await db
    .select()
    .from(longTermMemory)
    .orderBy(desc(longTermMemory.lastAccessed))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(longTermMemory);

  return {
    facts: rows.map((row) => ({
      knowledgeId: row.knowledgeId,
      distilledFact: row.distilledFact,
      embedding: [],
      lastAccessed: row.lastAccessed.toISOString(),
      provenance: row.provenance ?? [],
      metadata: row.metadata as Record<string, unknown>,
    })),
    total: totalRow.count,
  };
}

export async function getLtmCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(longTermMemory);
  return row.count;
}
