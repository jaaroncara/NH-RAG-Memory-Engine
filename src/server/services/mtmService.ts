import { getNeo4jDriver } from "../db/neo4j.js";
import { getProvider } from "../providers/index.js";

export interface GraphNode {
  nodeId: string;
  type: "episodic" | "semantic";
  content: string;
  embedding: number[];
  consolidatedAt: string;
  pageRank?: number;
  communityId?: number;
}

const SIMILARITY_THRESHOLD = 0.85;

export async function consolidateToMTM(
  interactionId: string,
  content: string
): Promise<string> {
  const provider = getProvider();
  const embedding = await provider.embed(content);
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    // 1. Create the EpisodicNode
    await session.run(
      `CREATE (n:EpisodicNode {
        nodeId: $nodeId,
        type: 'episodic',
        content: $content,
        embedding: $embedding,
        consolidatedAt: $consolidatedAt
      })`,
      {
        nodeId: interactionId,
        content,
        embedding,
        consolidatedAt: new Date().toISOString(),
      }
    );

    // 2. Build similarity edges with existing nodes
    const result = await session.run(
      `MATCH (existing:EpisodicNode)
       WHERE existing.nodeId <> $nodeId AND existing.embedding IS NOT NULL
       RETURN existing.nodeId AS id, existing.embedding AS emb`
    , { nodeId: interactionId });

    for (const record of result.records) {
      const otherId = record.get("id");
      const otherEmb = record.get("emb") as number[];
      const sim = cosineSimilarity(embedding, otherEmb);

      if (sim > SIMILARITY_THRESHOLD) {
        await session.run(
          `MATCH (a:EpisodicNode {nodeId: $a}), (b:EpisodicNode {nodeId: $b})
           MERGE (a)-[r:SIMILAR_TO]-(b)
           SET r.weight = $weight`,
          { a: interactionId, b: otherId, weight: sim }
        );
      }
    }

    return interactionId;
  } finally {
    await session.close();
  }
}

export async function getMtmCount(): Promise<number> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      "MATCH (n:EpisodicNode) RETURN count(n) AS cnt"
    );
    return result.records[0].get("cnt").toNumber();
  } finally {
    await session.close();
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  const denom = Math.sqrt(mA) * Math.sqrt(mB);
  return denom === 0 ? 0 : dot / denom;
}
