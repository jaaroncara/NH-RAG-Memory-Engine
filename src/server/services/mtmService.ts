import neo4j, { type Session } from "neo4j-driver";

import { getNeo4jDriver } from "../db/neo4j.js";
import { normalizeEmbedding } from "../embeddings.js";
import { getProvider } from "../providers/index.js";
import {
  extractSemanticEntities,
} from "./entityExtractionService.js";

export interface GraphNode {
  nodeId: string;
  memoryType: "document" | "chat";
  content: string;
  displayLabel: string;
  consolidatedAt: string;
  pageRank?: number;
  communityId?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "SIMILARITY";
  updatedAt?: string;
}

export interface TopicNodeRecord {
  topicId: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  mentionCount: number;
  confidence: number;
  lastMentionedAt: string | null;
  communityId?: number;
}

export interface MentionsEdge {
  chunkId: string;
  topicId: string;
  confidence: number;
  mentionCount: number;
  relationshipType: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  topicNodes: TopicNodeRecord[];
  mentionEdges: MentionsEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    documentNodeCount: number;
    chatNodeCount: number;
    similarityEdgeCount: number;
    topicNodeCount: number;
    mentionEdgeCount: number;
  };
}

const MTM_GRAPH_NODE_LABELS = ["MemoryNode", "TopicNode"];
const MTM_GRAPH_RELATIONSHIP_PROJECTION = {
  SIMILARITY: { orientation: "UNDIRECTED", properties: ["weight"] },
  MENTIONS: { orientation: "UNDIRECTED", properties: { weight: { property: "confidence", defaultValue: 0.5 } } },
};

export type RefreshMtmGraphAnalyticsStep = "projected" | "ranked" | "clustered";

export async function consolidateToMTM(
  interactionId: string,
  content: string,
  memoryType: "document" | "chat" = "chat"
): Promise<string> {
  const provider = getProvider();
  const [rawEmbedding, semanticEntities] = await Promise.all([
    provider.embed(content),
    extractSemanticEntities(content).catch((error) => {
      console.error("Semantic entity extraction failed:", error);
      return [];
    }),
  ]);
  const embedding = normalizeEmbedding(rawEmbedding);
  const driver = getNeo4jDriver();
  const session = driver.session();
  const consolidatedAt = new Date().toISOString();
  const nodeLabel = memoryType === "document" ? "DocumentMemory" : "ChatMemory";

  try {
    // 1. Create the MemoryNode — minimal schema, no SIMILARITY edges at insert time
    await session.run(
      `CREATE (n:MemoryNode:\`${nodeLabel}\` {
        nodeId:         $nodeId,
        memoryType:     $memoryType,
        content:        $content,
        embedding:      $embedding,
        consolidatedAt: $consolidatedAt
      })`,
      {
        nodeId: interactionId,
        memoryType,
        content,
        embedding,
        consolidatedAt,
      }
    );

    // 2. Create/merge TopicNodes and MENTIONS edges for each extracted entity
    if (semanticEntities.length > 0) {
      const topicParams = semanticEntities.map((entity) => ({
        topicId: entity.entityId,
        entityType: entity.entityType,
        canonicalName: entity.canonicalName,
        aliases: entity.aliases,
        confidence: entity.confidence,
        mentionCount: entity.mentionCount ?? 1,
        relationshipType: entity.relationshipType,
      }));

      await session.run(
        `UNWIND $topics AS topic
         MERGE (t:TopicNode { topicId: topic.topicId })
         ON CREATE SET
           t.entityType = topic.entityType,
           t.canonicalName = topic.canonicalName,
           t.aliases = topic.aliases,
           t.mentionCount = topic.mentionCount,
           t.confidence = topic.confidence,
           t.lastMentionedAt = $consolidatedAt
         ON MATCH SET
           t.mentionCount = t.mentionCount + topic.mentionCount,
           t.confidence = CASE WHEN topic.confidence > t.confidence THEN topic.confidence ELSE t.confidence END,
           t.lastMentionedAt = $consolidatedAt,
           t.canonicalName = CASE
             WHEN size(topic.canonicalName) > size(t.canonicalName)
             THEN topic.canonicalName
             ELSE t.canonicalName
           END
         WITH t, topic
         MATCH (c:MemoryNode { nodeId: $nodeId })
         MERGE (c)-[m:MENTIONS]->(t)
         ON CREATE SET
           m.confidence = topic.confidence,
           m.mentionCount = topic.mentionCount,
           m.relationshipType = topic.relationshipType
         ON MATCH SET
           m.mentionCount = m.mentionCount + topic.mentionCount,
           m.confidence = CASE WHEN topic.confidence > m.confidence THEN topic.confidence ELSE m.confidence END`,
        { topics: topicParams, nodeId: interactionId, consolidatedAt }
      );
    }

    return interactionId;
  } finally {
    await session.close();
  }
}

export async function pruneStaleTopicNodes(options?: {
  minMentionCount?: number;
  maxAgeDays?: number;
}): Promise<{ deleted: number }> {
  const minMentionCount = options?.minMentionCount ?? 2;
  const maxAgeDays = options?.maxAgeDays ?? 30;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:TopicNode)
       WHERE t.lastMentionedAt < $cutoff AND t.mentionCount < $minMentionCount
       WITH count(t) AS cnt, collect(t) AS stale
       FOREACH (t IN stale | DETACH DELETE t)
       RETURN cnt`,
      { cutoff, minMentionCount }
    );
    const deleted = result.records[0]?.get("cnt");
    return {
      deleted:
        typeof deleted === "object" && deleted !== null && "toNumber" in deleted
          ? (deleted as { toNumber(): number }).toNumber()
          : Number(deleted ?? 0),
    };
  } finally {
    await session.close();
  }
}

export async function getMtmCount(): Promise<number> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run("MATCH (n:MemoryNode) RETURN count(n) AS cnt");
    return result.records[0].get("cnt").toNumber();
  } finally {
    await session.close();
  }
}

export async function getTopicNodes(limit?: number): Promise<TopicNodeRecord[]> {
  const resolvedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : 500;
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:TopicNode)
       RETURN t.topicId AS topicId,
              t.entityType AS entityType,
              t.canonicalName AS canonicalName,
              coalesce(t.aliases, []) AS aliases,
              t.mentionCount AS mentionCount,
              t.confidence AS confidence,
              t.lastMentionedAt AS lastMentionedAt,
              t.communityId AS communityId
       ORDER BY t.mentionCount DESC
       LIMIT $limit`,
      { limit: neo4j.int(resolvedLimit) }
    );
    return result.records.map((record) => {
      const rawMentionCount = record.get("mentionCount");
      const mentionCount =
        typeof rawMentionCount === "object" && rawMentionCount !== null && "toNumber" in rawMentionCount
          ? (rawMentionCount as { toNumber(): number }).toNumber()
          : Number(rawMentionCount);
      const rawCommunityId = record.get("communityId");
      const communityId =
        rawCommunityId === null || rawCommunityId === undefined
          ? undefined
          : typeof rawCommunityId === "object" && "toNumber" in rawCommunityId
          ? (rawCommunityId as { toNumber(): number }).toNumber()
          : Number(rawCommunityId);
      return {
        topicId: record.get("topicId") as string,
        entityType: record.get("entityType") as string,
        canonicalName: record.get("canonicalName") as string,
        aliases: (record.get("aliases") as string[]) ?? [],
        mentionCount,
        confidence: Number(record.get("confidence")),
        lastMentionedAt: (record.get("lastMentionedAt") as string | null) ?? null,
        communityId,
      };
    });
  } finally {
    await session.close();
  }
}

export async function getMentionEdges(nodeIds: string[]): Promise<MentionsEdge[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (c:MemoryNode)-[m:MENTIONS]->(t:TopicNode)
       WHERE c.nodeId IN $nodeIds
       RETURN c.nodeId AS chunkId,
              t.topicId AS topicId,
              m.confidence AS confidence,
              m.mentionCount AS mentionCount,
              m.relationshipType AS relationshipType`,
      { nodeIds }
    );
    return result.records.map((record) => {
      const raw = record.get("mentionCount");
      const mentionCount =
        typeof raw === "object" && raw !== null && "toNumber" in raw
          ? (raw as { toNumber(): number }).toNumber()
          : Number(raw);
      return {
        chunkId: record.get("chunkId") as string,
        topicId: record.get("topicId") as string,
        confidence: Number(record.get("confidence")),
        mentionCount,
        relationshipType: record.get("relationshipType") as string,
      };
    });
  } finally {
    await session.close();
  }
}

export async function refreshMtmGraphAnalytics(options?: {
  onStep?: (step: RefreshMtmGraphAnalyticsStep) => Promise<void> | void;
}): Promise<void> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rankGraphName = `nhrag_mtm_rank_${ts}`;
  const communityGraphName = `nhrag_mtm_community_${ts}`;
  let rankProjected = false;
  let communityProjected = false;

  try {
    const countResult = await session.run("MATCH (n:MemoryNode) RETURN count(n) AS cnt");
    const nodeCount = countResult.records[0].get("cnt").toNumber();
    if (nodeCount === 0) {
      return;
    }

    // PageRank: MemoryNode only with SIMILARITY edges
    await session.run(
      `CALL gds.graph.project($graphName, ["MemoryNode"], {
        SIMILARITY: { orientation: "UNDIRECTED", properties: ["weight"] }
      })`,
      { graphName: rankGraphName }
    );
    rankProjected = true;
    await options?.onStep?.("projected");

    await session.run(
      `CALL gds.pageRank.write($graphName, {
        relationshipWeightProperty: 'weight',
        dampingFactor: 0.85,
        writeProperty: 'pageRank'
      })`,
      { graphName: rankGraphName }
    );
    await options?.onStep?.("ranked");

    // Community detection: MemoryNode + TopicNode with SIMILARITY + MENTIONS
    await session.run(
      `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
      {
        graphName: communityGraphName,
        nodeLabels: MTM_GRAPH_NODE_LABELS,
        relationshipProjection: MTM_GRAPH_RELATIONSHIP_PROJECTION,
      }
    );
    communityProjected = true;

    try {
      await session.run(
        `CALL gds.leiden.write($graphName, {
          relationshipWeightProperty: 'weight',
          writeProperty: 'communityId',
          gamma: 1.0,
          theta: 0.01
        })`,
        { graphName: communityGraphName }
      );
    } catch (error) {
      console.warn("gds.leiden not available, falling back to gds.louvain:", error);
      await session.run(
        `CALL gds.louvain.write($graphName, {
          relationshipWeightProperty: 'weight',
          writeProperty: 'communityId'
        })`,
        { graphName: communityGraphName }
      );
    }
    await options?.onStep?.("clustered");
  } finally {
    if (rankProjected) {
      try {
        await session.run(`CALL gds.graph.drop($graphName)`, { graphName: rankGraphName });
      } catch (error) {
        console.error("Failed to drop PageRank projection:", error);
      }
    }
    if (communityProjected) {
      try {
        await session.run(`CALL gds.graph.drop($graphName)`, { graphName: communityGraphName });
      } catch (error) {
        console.error("Failed to drop community projection:", error);
      }
    }
    await session.close();
  }
}

export async function getGraphStats(): Promise<GraphSnapshot["stats"]> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const nodeResult = await session.run(
      `MATCH (n:MemoryNode)
       RETURN count(n) AS nodeCount,
              sum(CASE WHEN n:DocumentMemory THEN 1 ELSE 0 END) AS documentNodeCount,
              sum(CASE WHEN n:ChatMemory THEN 1 ELSE 0 END) AS chatNodeCount`
    );
    const similarityEdgeResult = await session.run(
      "MATCH ()-[r:SIMILARITY]-() RETURN count(r) / 2 AS similarityEdgeCount"
    );
    const communityResult = await session.run(
      `MATCH (n:MemoryNode)
       WHERE n.communityId IS NOT NULL
       RETURN count(DISTINCT n.communityId) AS communityCount`
    );
    const topicNodeResult = await session.run(
      "MATCH (t:TopicNode) RETURN count(t) AS topicNodeCount"
    );
    const mentionEdgeResult = await session.run(
      "MATCH ()-[m:MENTIONS]->() RETURN count(m) AS mentionEdgeCount"
    );

    const nodeCount = nodeResult.records[0].get("nodeCount").toNumber();
    const documentNodeCount = nodeResult.records[0].get("documentNodeCount").toNumber();
    const chatNodeCount = nodeResult.records[0].get("chatNodeCount").toNumber();
    const similarityEdgeCount = similarityEdgeResult.records[0].get("similarityEdgeCount").toNumber();
    const communityCount = communityResult.records[0].get("communityCount").toNumber();
    const topicNodeCount = topicNodeResult.records[0].get("topicNodeCount").toNumber();
    const mentionEdgeCount = mentionEdgeResult.records[0].get("mentionEdgeCount").toNumber();

    return {
      nodeCount,
      edgeCount: similarityEdgeCount,
      communityCount,
      documentNodeCount,
      chatNodeCount,
      similarityEdgeCount,
      topicNodeCount,
      mentionEdgeCount,
    };
  } finally {
    await session.close();
  }
}

export async function getGraphSnapshot(limit?: number): Promise<GraphSnapshot> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  const normalizedLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(Math.floor(limit), 1)
      : undefined;

  try {
    const nodeQuery =
      normalizedLimit === undefined
        ? `MATCH (n:MemoryNode)
           RETURN n.nodeId AS nodeId,
                  n.memoryType AS memoryType,
                  n.content AS content,
                  n.consolidatedAt AS consolidatedAt,
                  coalesce(n.pageRank, 0.0) AS pageRank,
                  coalesce(n.communityId, -1) AS communityId
           ORDER BY n.consolidatedAt DESC`
        : `MATCH (n:MemoryNode)
           RETURN n.nodeId AS nodeId,
                  n.memoryType AS memoryType,
                  n.content AS content,
                  n.consolidatedAt AS consolidatedAt,
                  coalesce(n.pageRank, 0.0) AS pageRank,
                  coalesce(n.communityId, -1) AS communityId
           ORDER BY n.consolidatedAt DESC
           LIMIT $limit`;

    const nodeResult = await session.run(
      nodeQuery,
      normalizedLimit === undefined ? {} : { limit: neo4j.int(normalizedLimit) }
    );

    const memoryNodes = nodeResult.records.map((record) => {
      const rawType = record.get("memoryType") as string | null;
      const memoryType: "document" | "chat" =
        rawType === "document" ? "document" : "chat";
      return {
        nodeId: record.get("nodeId") as string,
        memoryType,
        content: record.get("content") as string,
        displayLabel: record.get("content") as string,
        consolidatedAt: record.get("consolidatedAt") as string,
        pageRank: Number(record.get("pageRank") as number),
        communityId: Number(record.get("communityId") as number),
      };
    });

    const nodeIds = memoryNodes.map((node) => node.nodeId);
    if (nodeIds.length === 0) {
      return {
        nodes: [],
        edges: [],
        topicNodes: [],
        mentionEdges: [],
        stats: await getGraphStats(),
      };
    }

    const edgeResult = await session.run(
      `MATCH (a:MemoryNode)-[r:SIMILARITY]-(b:MemoryNode)
       WHERE a.nodeId IN $nodeIds AND b.nodeId IN $nodeIds AND a.nodeId < b.nodeId
       RETURN a.nodeId AS source,
              b.nodeId AS target,
              coalesce(r.weight, 0.0) AS weight,
              r.updatedAt AS updatedAt`,
      { nodeIds }
    );

    const edges: GraphEdge[] = edgeResult.records.map((record) => ({
      source: record.get("source") as string,
      target: record.get("target") as string,
      weight: Number(record.get("weight") as number),
      type: "SIMILARITY" as const,
      updatedAt: (record.get("updatedAt") as string | null) ?? undefined,
    }));

    const [allTopicNodes, mentionEdges] = await Promise.all([
      getTopicNodes(500),
      getMentionEdges(nodeIds),
    ]);
    const referencedTopicIds = new Set(mentionEdges.map((e) => e.topicId));
    const topicNodes = allTopicNodes.filter((t) => referencedTopicIds.has(t.topicId));

    const stats =
      normalizedLimit === undefined
        ? {
          nodeCount: memoryNodes.length,
          edgeCount: edges.length,
          communityCount: new Set(
            memoryNodes
              .map((node) => node.communityId)
              .filter((value) => value !== undefined && value !== -1)
          ).size,
          documentNodeCount: memoryNodes.filter((n) => n.memoryType === "document").length,
          chatNodeCount: memoryNodes.filter((n) => n.memoryType === "chat").length,
          similarityEdgeCount: edges.length,
          topicNodeCount: topicNodes.length,
          mentionEdgeCount: mentionEdges.length,
        }
        : await getGraphStats();

    return {
      nodes: memoryNodes,
      edges,
      topicNodes,
      mentionEdges,
      stats,
    };
  } finally {
    await session.close();
  }
}
