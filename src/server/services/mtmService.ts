import neo4j from "neo4j-driver";

import { getNeo4jDriver } from "../db/neo4j.js";
import { normalizeEmbedding } from "../embeddings.js";
import { getProvider } from "../providers/index.js";

export interface GraphNode {
  nodeId: string;
  type: "episodic" | "semantic";
  content: string;
  consolidatedAt: string;
  pageRank?: number;
  communityId?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
  };
}

const SIMILARITY_THRESHOLD = 0.85;

export async function consolidateToMTM(
  interactionId: string,
  content: string
): Promise<string> {
  const provider = getProvider();
  const embedding = normalizeEmbedding(await provider.embed(content));
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
      const otherEmb = normalizeEmbedding(record.get("emb") as number[]);
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

export async function getGraphSnapshot(limit = 40): Promise<GraphSnapshot> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  const normalizedLimit = Math.max(Math.floor(limit), 1);

  try {
    const nodeResult = await session.run(
      `MATCH (n:EpisodicNode)
       RETURN n.nodeId AS nodeId,
              n.type AS type,
              n.content AS content,
              n.consolidatedAt AS consolidatedAt,
              coalesce(n.pageRank, 0.0) AS pageRank,
              coalesce(n.communityId, -1) AS communityId
       ORDER BY n.consolidatedAt DESC
       LIMIT $limit`,
      { limit: neo4j.int(normalizedLimit) }
    );

    const nodes = nodeResult.records.map((record) => ({
      nodeId: record.get("nodeId") as string,
      type: (record.get("type") as "episodic" | "semantic") ?? "episodic",
      content: record.get("content") as string,
      consolidatedAt: record.get("consolidatedAt") as string,
      pageRank: Number(record.get("pageRank") as number),
      communityId: Number(record.get("communityId") as number),
    }));

    const nodeIds = nodes.map((node) => node.nodeId);
    if (nodeIds.length === 0) {
      return {
        nodes: [],
        edges: [],
        stats: { nodeCount: 0, edgeCount: 0, communityCount: 0 },
      };
    }

    const edgeResult = await session.run(
      `MATCH (a:EpisodicNode)-[r:SIMILAR_TO]-(b:EpisodicNode)
       WHERE a.nodeId IN $nodeIds AND b.nodeId IN $nodeIds AND a.nodeId < b.nodeId
       RETURN a.nodeId AS source, b.nodeId AS target, r.weight AS weight`,
      { nodeIds }
    );

    const edges = edgeResult.records.map((record) => ({
      source: record.get("source") as string,
      target: record.get("target") as string,
      weight: Number(record.get("weight") as number),
    }));

    const communityCount = new Set(
      nodes.map((node) => node.communityId).filter((value) => value !== -1)
    ).size;

    return {
      nodes,
      edges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        communityCount,
      },
    };
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
