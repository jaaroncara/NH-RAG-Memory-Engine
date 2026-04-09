import { db } from "../db/index.js";
import { longTermMemory } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { getProvider } from "../providers/index.js";

export interface SemanticFact {
  knowledgeId: string;
  distilledFact: string;
  embedding: number[];
  lastAccessed: string;
  provenance: string[];
  score?: number;
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
  provenance: string[]
): Promise<string> {
  const [row] = await db
    .insert(longTermMemory)
    .values({ distilledFact, embedding, provenance })
    .returning({ id: longTermMemory.knowledgeId });
  return row.id;
}

export async function getLtmCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(longTermMemory);
  return row.count;
}
