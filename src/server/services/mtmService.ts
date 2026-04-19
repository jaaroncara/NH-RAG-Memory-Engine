import neo4j, { type Session } from "neo4j-driver";

import { getNeo4jDriver } from "../db/neo4j.js";
import { normalizeEmbedding } from "../embeddings.js";
import { getProvider } from "../providers/index.js";
import {
  extractSemanticEntities,
  type SemanticEntityType,
  type SemanticRelationshipType,
} from "./entityExtractionService.js";
import {
  buildSemanticEdgeProperties,
  buildSemanticNodeProperties,
  parseSharedSemanticEntities,
  parseStoredSemanticEntities,
  type SharedSemanticEntity,
  type StoredSemanticEntity,
} from "./semanticGraphAttributes.js";

export interface GraphNode {
  nodeId: string;
  type: "episodic" | "chunk";
  content: string;
  displayLabel: string;
  consolidatedAt: string;
  pageRank?: number;
  communityId?: number;
  semanticEntityCount: number;
  semanticMaxConfidence: number;
  semanticEntities: StoredSemanticEntity[];
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "SIMILAR_TO";
  cosineWeight: number;
  semanticOverlapWeight: number;
  sharedEntityCount: number;
  sharedEntities: SharedSemanticEntity[];
  updatedAt?: string;
}

export interface TopicNodeRecord {
  topicId: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  mentionCount: number;
  confidence: number;
  lastMentionedAt: string;
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
    episodicNodeCount: number;
    annotatedNodeCount: number;
    similarityEdgeCount: number;
    overlapEdgeCount: number;
    topicNodeCount: number;
    mentionEdgeCount: number;
  };
}

const SIMILARITY_THRESHOLD = 0.72;
const MTM_GRAPH_NODE_LABELS = ["EpisodicNode"];
const MTM_GRAPH_RELATIONSHIP_PROJECTION = {
  SIMILAR_TO: { orientation: "UNDIRECTED", properties: ["combinedWeight"] },
};

export type RefreshMtmGraphAnalyticsStep = "projected" | "ranked" | "clustered";

export async function consolidateToMTM(
  interactionId: string,
  content: string
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
  const semanticNodeProperties = buildSemanticNodeProperties(semanticEntities);
  const driver = getNeo4jDriver();
  const session = driver.session();
  const consolidatedAt = new Date().toISOString();

  try {
    // 1. Create the ChunkNode with dual label for backward compat with EpisodicNode consumers
    await session.run(
      `CREATE (n:EpisodicNode:ChunkNode {
        nodeId: $nodeId,
        type: 'chunk',
        content: $content,
        embedding: $embedding,
        consolidatedAt: $consolidatedAt,
        semanticEntityCount: $semanticEntityCount,
        semanticEntityKeys: $semanticEntityKeys,
        semanticEntityNames: $semanticEntityNames,
        semanticEntityTypes: $semanticEntityTypes,
        semanticRelationshipTypes: $semanticRelationshipTypes,
        semanticMaxConfidence: $semanticMaxConfidence,
        semanticPayloadJson: $semanticPayloadJson
      })`,
      {
        nodeId: interactionId,
        content,
        embedding,
        consolidatedAt,
        semanticEntityCount: semanticNodeProperties.semanticEntityCount,
        semanticEntityKeys: semanticNodeProperties.semanticEntityKeys,
        semanticEntityNames: semanticNodeProperties.semanticEntityNames,
        semanticEntityTypes: semanticNodeProperties.semanticEntityTypes,
        semanticRelationshipTypes: semanticNodeProperties.semanticRelationshipTypes,
        semanticMaxConfidence: semanticNodeProperties.semanticMaxConfidence,
        semanticPayloadJson: semanticNodeProperties.semanticPayloadJson,
      }
    );

    // 1b. Create/merge TopicNodes and MENTIONS edges for each extracted entity
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
         MATCH (c:ChunkNode { nodeId: $nodeId })
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

    // 2. Build similarity edges with existing nodes (unchanged — required for GDS PageRank/Louvain)
    const result = await session.run(
      `MATCH (existing:EpisodicNode)
       WHERE existing.nodeId <> $nodeId AND existing.embedding IS NOT NULL
       RETURN existing.nodeId AS id,
              existing.embedding AS emb,
              coalesce(existing.semanticPayloadJson, '[]') AS semanticPayloadJson`,
      { nodeId: interactionId }
    );

    for (const record of result.records) {
      const otherId = record.get("id");
      const otherEmb = normalizeEmbedding(record.get("emb") as number[]);
      const sim = cosineSimilarity(embedding, otherEmb);

      if (sim > SIMILARITY_THRESHOLD) {
        const otherSemanticEntities = parseStoredSemanticEntities(
          record.get("semanticPayloadJson") as string
        );
        const edgeProperties = buildSemanticEdgeProperties(
          semanticNodeProperties.semanticEntities,
          otherSemanticEntities,
          sim
        );

        await session.run(
          `MATCH (a:EpisodicNode {nodeId: $a}), (b:EpisodicNode {nodeId: $b})
           MERGE (a)-[r:SIMILAR_TO]-(b)
           SET r.weight = $weight,
               r.cosineWeight = $cosineWeight,
               r.semanticOverlapWeight = $semanticOverlapWeight,
               r.combinedWeight = $combinedWeight,
               r.sharedEntityCount = $sharedEntityCount,
               r.sharedEntityKeys = $sharedEntityKeys,
               r.sharedEntityNames = $sharedEntityNames,
               r.sharedEntityTypes = $sharedEntityTypes,
               r.semanticOverlapJson = $semanticOverlapJson,
               r.updatedAt = $updatedAt`,
          {
            a: interactionId,
            b: otherId,
            weight: edgeProperties.weight,
            cosineWeight: edgeProperties.cosineWeight,
            semanticOverlapWeight: edgeProperties.semanticOverlapWeight,
            combinedWeight: edgeProperties.combinedWeight,
            sharedEntityCount: neo4j.int(edgeProperties.sharedEntityCount),
            sharedEntityKeys: edgeProperties.sharedEntityKeys,
            sharedEntityNames: edgeProperties.sharedEntityNames,
            sharedEntityTypes: edgeProperties.sharedEntityTypes,
            semanticOverlapJson: edgeProperties.semanticOverlapJson,
            updatedAt: consolidatedAt,
          }
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
    const result = await session.run("MATCH (n:EpisodicNode) RETURN count(n) AS cnt");
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
      `MATCH (t:TopicNode) RETURN t ORDER BY t.mentionCount DESC LIMIT $limit`,
      { limit: neo4j.int(resolvedLimit) }
    );
    return result.records.map((record) => {
      const props = record.get("t").properties as Record<string, unknown>;
      const raw = props.mentionCount;
      const mentionCount =
        typeof raw === "object" && raw !== null && "toNumber" in raw
          ? (raw as { toNumber(): number }).toNumber()
          : Number(raw);
      return {
        topicId: props.topicId as string,
        entityType: props.entityType as string,
        canonicalName: props.canonicalName as string,
        aliases: (props.aliases as string[]) ?? [],
        mentionCount,
        confidence: Number(props.confidence),
        lastMentionedAt: props.lastMentionedAt as string,
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
      `MATCH (c:ChunkNode)-[m:MENTIONS]->(t:TopicNode)
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
  const graphName = `nhrag_mtm_refresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let graphProjected = false;

  try {
    const countResult = await session.run("MATCH (n:EpisodicNode) RETURN count(n) AS cnt");
    const nodeCount = countResult.records[0].get("cnt").toNumber();
    if (nodeCount === 0) {
      return;
    }

    await session.run(
      `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
      {
        graphName,
        nodeLabels: MTM_GRAPH_NODE_LABELS,
        relationshipProjection: MTM_GRAPH_RELATIONSHIP_PROJECTION,
      }
    );
    graphProjected = true;
    await options?.onStep?.("projected");

    await session.run(
      `CALL gds.pageRank.write($graphName, {
        relationshipWeightProperty: 'weight',
        dampingFactor: 0.85,
        writeProperty: 'pageRank'
      })`,
      { graphName }
    );
    await options?.onStep?.("ranked");

    await session.run(
      `CALL gds.louvain.write($graphName, {
        relationshipWeightProperty: 'weight',
        writeProperty: 'communityId'
      })`,
      { graphName }
    );
    await options?.onStep?.("clustered");
  } finally {
    if (graphProjected) {
      try {
        await session.run(`CALL gds.graph.drop($graphName)`, { graphName });
      } catch (error) {
        console.error("Failed to drop projected MTM analytics graph:", error);
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
      `MATCH (n:EpisodicNode)
       RETURN count(n) AS nodeCount,
              count(n) AS episodicNodeCount,
              coalesce(sum(CASE WHEN coalesce(n.semanticEntityCount, 0) > 0 THEN 1 ELSE 0 END), 0) AS annotatedNodeCount`
    );
    const similarityEdgeResult = await session.run(
      "MATCH ()-[r:SIMILAR_TO]-() RETURN count(r) AS similarityEdgeCount"
    );
    const overlapEdgeResult = await session.run(
      `MATCH ()-[r:SIMILAR_TO]-()
       RETURN coalesce(sum(CASE WHEN coalesce(r.sharedEntityCount, 0) > 0 THEN 1 ELSE 0 END), 0) AS overlapEdgeCount`
    );
    const communityResult = await session.run(
      `MATCH (n:EpisodicNode)
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
    const episodicNodeCount = nodeResult.records[0].get("episodicNodeCount").toNumber();
    const annotatedNodeCount = nodeResult.records[0].get("annotatedNodeCount").toNumber();
    const similarityEdgeCount = similarityEdgeResult.records[0].get("similarityEdgeCount").toNumber();
    const overlapEdgeCount = overlapEdgeResult.records[0].get("overlapEdgeCount").toNumber();
    const communityCount = communityResult.records[0].get("communityCount").toNumber();
    const topicNodeCount = topicNodeResult.records[0].get("topicNodeCount").toNumber();
    const mentionEdgeCount = mentionEdgeResult.records[0].get("mentionEdgeCount").toNumber();

    return {
      nodeCount,
      edgeCount: similarityEdgeCount,
      communityCount,
      episodicNodeCount,
      annotatedNodeCount,
      similarityEdgeCount,
      overlapEdgeCount,
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
    const episodicNodeQuery =
      normalizedLimit === undefined
        ? `MATCH (n:EpisodicNode)
           RETURN n.nodeId AS nodeId,
                  n.type AS type,
                  n.content AS content,
                  n.content AS displayLabel,
                  n.consolidatedAt AS consolidatedAt,
                  coalesce(n.pageRank, 0.0) AS pageRank,
                  coalesce(n.communityId, -1) AS communityId,
              coalesce(n.semanticEntityCount, 0) AS semanticEntityCount,
              coalesce(n.semanticMaxConfidence, 0.0) AS semanticMaxConfidence,
              coalesce(n.semanticPayloadJson, '[]') AS semanticPayloadJson
           ORDER BY n.consolidatedAt DESC`
        : `MATCH (n:EpisodicNode)
           RETURN n.nodeId AS nodeId,
                  n.type AS type,
                  n.content AS content,
                  n.content AS displayLabel,
                  n.consolidatedAt AS consolidatedAt,
                  coalesce(n.pageRank, 0.0) AS pageRank,
                  coalesce(n.communityId, -1) AS communityId,
              coalesce(n.semanticEntityCount, 0) AS semanticEntityCount,
              coalesce(n.semanticMaxConfidence, 0.0) AS semanticMaxConfidence,
              coalesce(n.semanticPayloadJson, '[]') AS semanticPayloadJson
           ORDER BY n.consolidatedAt DESC
           LIMIT $limit`;

    const episodicNodeResult = await session.run(
      episodicNodeQuery,
      normalizedLimit === undefined ? {} : { limit: neo4j.int(normalizedLimit) }
    );

    const episodicNodes = episodicNodeResult.records.map((record) => ({
      nodeId: record.get("nodeId") as string,
      type: (record.get("type") as string) === "chunk" ? ("chunk" as const) : ("episodic" as const),
      content: record.get("content") as string,
      displayLabel: (record.get("displayLabel") as string) ?? (record.get("content") as string),
      consolidatedAt: record.get("consolidatedAt") as string,
      pageRank: Number(record.get("pageRank") as number),
      communityId: Number(record.get("communityId") as number),
      semanticEntityCount: Number(record.get("semanticEntityCount") as number),
      semanticMaxConfidence: Number(record.get("semanticMaxConfidence") as number),
      semanticEntities: parseStoredSemanticEntities(
        record.get("semanticPayloadJson") as string
      ),
    }));

    const episodicNodeIds = episodicNodes.map((node) => node.nodeId);
    if (episodicNodeIds.length === 0) {
      return {
        nodes: [],
        edges: [],
        topicNodes: [],
        mentionEdges: [],
        stats: await getGraphStats(),
      };
    }
    const nodes = episodicNodes;

    const edgeResult = await session.run(
      `MATCH (a:EpisodicNode)-[r:SIMILAR_TO]-(b:EpisodicNode)
       WHERE a.nodeId IN $nodeIds AND b.nodeId IN $nodeIds AND a.nodeId < b.nodeId
       RETURN a.nodeId AS source,
              b.nodeId AS target,
              coalesce(r.combinedWeight, r.weight, 0.0) AS weight,
              coalesce(r.cosineWeight, r.weight, 0.0) AS cosineWeight,
              coalesce(r.semanticOverlapWeight, 0.0) AS semanticOverlapWeight,
              coalesce(r.sharedEntityCount, 0) AS sharedEntityCount,
              coalesce(r.semanticOverlapJson, '[]') AS semanticOverlapJson,
              r.updatedAt AS updatedAt`,
      { nodeIds: episodicNodeIds }
    );

    const edges = edgeResult.records.map((record) => ({
      source: record.get("source") as string,
      target: record.get("target") as string,
      weight: Number(record.get("weight") as number),
      type: "SIMILAR_TO" as const,
      cosineWeight: Number(record.get("cosineWeight") as number),
      semanticOverlapWeight: Number(record.get("semanticOverlapWeight") as number),
      sharedEntityCount: Number(record.get("sharedEntityCount") as number),
      sharedEntities: parseSharedSemanticEntities(
        record.get("semanticOverlapJson") as string
      ),
      updatedAt: (record.get("updatedAt") as string | null) ?? undefined,
    }));

    // Fetch TopicNodes referenced by the chunk nodes in view
    const topicNodes = await getTopicNodes(500);

    // Fetch MENTIONS edges for the chunks in view
    const mentionEdges = await getMentionEdges(episodicNodeIds);

    const stats =
      normalizedLimit === undefined
        ? {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          communityCount: new Set(
            episodicNodes
              .map((node) => node.communityId)
              .filter((value) => value !== undefined && value !== -1)
          ).size,
          episodicNodeCount: episodicNodes.length,
          annotatedNodeCount: episodicNodes.filter(
            (node) => node.semanticEntityCount > 0
          ).length,
          similarityEdgeCount: edges.length,
          overlapEdgeCount: edges.filter((edge) => edge.sharedEntityCount > 0).length,
          topicNodeCount: topicNodes.length,
          mentionEdgeCount: mentionEdges.length,
        }
        : await getGraphStats();

    return {
      nodes,
      edges,
      topicNodes,
      mentionEdges,
      stats,
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
