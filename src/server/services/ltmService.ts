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

  const facts = (rows.rows as Record<string, unknown>[]).map(toSemanticFact);

  // Fire-and-forget: update access stats for retrieved facts
  const retrievedIds = facts.map((f) => f.knowledgeId).filter(Boolean);
  if (retrievedIds.length > 0) {
    const pgArrayLiteral = `{${retrievedIds.join(",")}}`;
    db.execute(sql`
      UPDATE long_term_memory
      SET last_accessed = NOW(),
          access_count = access_count + 1
      WHERE knowledge_id = ANY(${pgArrayLiteral}::uuid[])
    `).catch((err: unknown) => console.error("[ltmService] Failed to update access stats:", err));
  }

  return facts;
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

export interface LtmCondensationResult {
  clustersFound: number;
  factsCondensed: number;
  newFactsCreated: number;
}

/**
 * Find clusters of dormant LTM facts (never accessed, older than dormancyDays)
 * that are semantically similar to each other (cosine similarity >= similarityThreshold),
 * and re-distill each cluster into a single coarser summary via the LLM.
 * Originals are deleted after the condensed replacement is stored.
 *
 * This mimics neocortical memory compression: old, unused memories lose
 * episodic specificity and merge into more abstract semantic knowledge.
 */
export async function condenseLtmFacts(opts?: {
  dormancyDays?: number;
  similarityThreshold?: number;
}): Promise<LtmCondensationResult> {
  const dormancyDays = opts?.dormancyDays ?? 60;
  const similarityThreshold = opts?.similarityThreshold ?? 0.88;
  const distanceThreshold = 1 - similarityThreshold;

  // 1. Fetch facts that have never been accessed and are older than the dormancy window
  const dormantResult = await db.execute(sql`
    SELECT knowledge_id, distilled_fact, provenance, metadata
    FROM long_term_memory
    WHERE access_count = 0
      AND created_at < NOW() - (${dormancyDays} * INTERVAL '1 day')
  `);

  type DormantRow = { knowledge_id: string; distilled_fact: string; provenance: string[] | null; metadata: Record<string, unknown> | null };
  const dormantFacts = dormantResult.rows as DormantRow[];

  if (dormantFacts.length < 2) {
    return { clustersFound: 0, factsCondensed: 0, newFactsCreated: 0 };
  }

  const dormantIds = dormantFacts.map((f) => f.knowledge_id);
  const idToFact = new Map(dormantFacts.map((f) => [f.knowledge_id, f]));

  // 2. Self-join cosine similarity: find pairs within the dormant set that are close enough to merge
  // UUIDs are hex + hyphens only, so the {id1,id2,...} array literal is injection-safe
  const pgArrayLiteral = `{${dormantIds.join(",")}}`;
  const pairResult = await db.execute(sql`
    SELECT a.knowledge_id AS a_id, b.knowledge_id AS b_id
    FROM long_term_memory a
    JOIN long_term_memory b ON a.knowledge_id < b.knowledge_id
    WHERE a.knowledge_id = ANY(${pgArrayLiteral}::uuid[])
      AND b.knowledge_id = ANY(${pgArrayLiteral}::uuid[])
      AND (a.embedding <=> b.embedding) < ${distanceThreshold}
  `);

  const pairs = pairResult.rows as { a_id: string; b_id: string }[];

  if (pairs.length === 0) {
    return { clustersFound: 0, factsCondensed: 0, newFactsCreated: 0 };
  }

  // 3. Union-Find: group connected components from the similarity pair graph
  const parent = new Map<string, string>(dormantIds.map((id) => [id, id]));

  function find(x: string): string {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(x: string, y: string): void {
    parent.set(find(x), find(y));
  }

  for (const { a_id, b_id } of pairs) {
    union(a_id, b_id);
  }

  const clusterMap = new Map<string, string[]>();
  for (const id of dormantIds) {
    const root = find(id);
    const group = clusterMap.get(root) ?? [];
    group.push(id);
    clusterMap.set(root, group);
  }

  const eligibleClusters = Array.from(clusterMap.values()).filter((g) => g.length >= 2);

  if (eligibleClusters.length === 0) {
    return { clustersFound: 0, factsCondensed: 0, newFactsCreated: 0 };
  }

  // 4. Distill each cluster and replace originals with a coarser condensed fact
  const provider = getProvider();
  let factsCondensed = 0;
  let newFactsCreated = 0;

  for (const clusterIds of eligibleClusters) {
    const clusterFacts = clusterIds.map((id) => idToFact.get(id)!);
    const factTexts = clusterFacts.map((f) => f.distilled_fact);

    const prompt = [
      "The following memory facts were recorded long ago and have never been accessed since.",
      "Synthesize them into a single, more abstract summary that captures the essential pattern without episodic detail.",
      "Be concise — 1 to 2 sentences. Do not invent facts not supported by the inputs.",
      "",
      "Facts:",
      ...factTexts.map((t) => `- ${t}`),
    ].join("\n");

    const condensedFact = await provider.generate(prompt);
    if (!condensedFact) continue;

    const embedding = await provider.embed(condensedFact);
    const mergedProvenance = Array.from(new Set(clusterFacts.flatMap((f) => f.provenance ?? [])));

    await storeFact(condensedFact, embedding, mergedProvenance, {
      fidelity_level: "condensed",
      condensed_from: clusterIds,
      condensed_at: new Date().toISOString(),
    });

    // Delete source facts now that the condensed replacement is persisted
    const deleteIds = `{${clusterIds.join(",")}}`;
    await db.execute(sql`
      DELETE FROM long_term_memory
      WHERE knowledge_id = ANY(${deleteIds}::uuid[])
    `);

    factsCondensed += clusterIds.length;
    newFactsCreated += 1;
  }

  return { clustersFound: eligibleClusters.length, factsCondensed, newFactsCreated };
}
