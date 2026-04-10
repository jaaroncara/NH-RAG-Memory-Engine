import neo4j, { type Session } from "neo4j-driver";

import { getNeo4jDriver } from "../db/neo4j.js";
import { normalizeEmbedding } from "../embeddings.js";
import { getProvider } from "../providers/index.js";
import { extractSemanticEntities, type ExtractedEntity, type SemanticEntityType, type SemanticRelationshipType } from "./entityExtractionService.js";

export interface GraphNode {
  nodeId: string;
  type: "episodic" | "semantic";
  content: string;
  displayLabel: string;
  consolidatedAt: string;
  pageRank?: number;
  communityId?: number;
  entityType?: SemanticEntityType;
  aliases?: string[];
  mentionCount?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "SIMILAR_TO" | SemanticRelationshipType;
  confidence?: number;
  relationshipHint?: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    episodicNodeCount: number;
    semanticNodeCount: number;
    similarityEdgeCount: number;
    semanticEdgeCount: number;
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
  const consolidatedAt = new Date().toISOString();

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
        consolidatedAt,
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

    // 3. Extract and link semantic entities without failing MTM promotion
    try {
      const semanticEntities = await extractSemanticEntities(content);
      for (const entity of semanticEntities) {
        await upsertSemanticEntity(session, interactionId, entity, consolidatedAt);
      }
    } catch (error) {
      console.error("Semantic entity extraction failed:", error);
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
      "MATCH (n) WHERE n:EpisodicNode OR n:SemanticNode RETURN count(n) AS cnt"
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
    const episodicNodeResult = await session.run(
      `MATCH (n:EpisodicNode)
       RETURN n.nodeId AS nodeId,
              n.type AS type,
              n.content AS content,
              n.content AS displayLabel,
              n.consolidatedAt AS consolidatedAt,
              coalesce(n.pageRank, 0.0) AS pageRank,
              coalesce(n.communityId, -1) AS communityId,
              null AS entityType,
              [] AS aliases,
              0 AS mentionCount
       ORDER BY n.consolidatedAt DESC
       LIMIT $limit`,
      { limit: neo4j.int(normalizedLimit) }
    );

    const episodicNodes = episodicNodeResult.records.map((record) => ({
      nodeId: record.get("nodeId") as string,
      type: (record.get("type") as "episodic" | "semantic") ?? "episodic",
      content: record.get("content") as string,
      displayLabel: (record.get("displayLabel") as string) ?? (record.get("content") as string),
      consolidatedAt: record.get("consolidatedAt") as string,
      pageRank: Number(record.get("pageRank") as number),
      communityId: Number(record.get("communityId") as number),
      entityType: undefined,
      aliases: [],
      mentionCount: 0,
    }));

    const episodicNodeIds = episodicNodes.map((node) => node.nodeId);
    if (episodicNodeIds.length === 0) {
      return {
        nodes: [],
        edges: [],
        stats: {
          nodeCount: 0,
          edgeCount: 0,
          communityCount: 0,
          episodicNodeCount: 0,
          semanticNodeCount: 0,
          similarityEdgeCount: 0,
          semanticEdgeCount: 0,
        },
      };
    }

    const semanticNodeResult = await session.run(
      `MATCH (e:EpisodicNode)-[r]->(s:SemanticNode)
       WHERE e.nodeId IN $nodeIds
       RETURN DISTINCT s.entityId AS nodeId,
              'semantic' AS type,
              s.canonicalName AS content,
              s.canonicalName AS displayLabel,
              coalesce(s.updatedAt, s.createdAt) AS consolidatedAt,
              coalesce(s.pageRank, 0.0) AS pageRank,
              coalesce(s.communityId, -1) AS communityId,
              s.entityType AS entityType,
              coalesce(s.aliases, []) AS aliases,
              coalesce(s.mentionCount, 0) AS mentionCount`,
      { nodeIds: episodicNodeIds }
    );

    const semanticNodes = semanticNodeResult.records.map((record) => ({
      nodeId: record.get("nodeId") as string,
      type: "semantic" as const,
      content: (record.get("content") as string) ?? "",
      displayLabel: (record.get("displayLabel") as string) ?? (record.get("content") as string) ?? "",
      consolidatedAt: (record.get("consolidatedAt") as string) ?? "",
      pageRank: Number(record.get("pageRank") as number),
      communityId: Number(record.get("communityId") as number),
      entityType: (record.get("entityType") as SemanticEntityType) ?? undefined,
      aliases: ((record.get("aliases") as string[] | null) ?? []).map((alias) => String(alias)),
      mentionCount: Number(record.get("mentionCount") as number),
    }));

    const nodes = [...episodicNodes, ...semanticNodes];

    const edgeResult = await session.run(
      `MATCH (a:EpisodicNode)-[r:SIMILAR_TO]-(b:EpisodicNode)
       WHERE a.nodeId IN $nodeIds AND b.nodeId IN $nodeIds AND a.nodeId < b.nodeId
       RETURN a.nodeId AS source,
              b.nodeId AS target,
              type(r) AS type,
              r.weight AS weight,
              null AS confidence,
              null AS relationshipHint
       UNION
       MATCH (e:EpisodicNode)-[r]->(s:SemanticNode)
       WHERE e.nodeId IN $nodeIds
       RETURN e.nodeId AS source,
              s.entityId AS target,
              type(r) AS type,
              coalesce(r.weight, 1.0) AS weight,
              coalesce(r.confidence, 1.0) AS confidence,
              r.relationshipHint AS relationshipHint`,
      { nodeIds: episodicNodeIds }
    );

    const edges = edgeResult.records.map((record) => ({
      source: record.get("source") as string,
      target: record.get("target") as string,
      weight: Number(record.get("weight") as number),
      type: record.get("type") as "SIMILAR_TO" | SemanticRelationshipType,
      confidence:
        record.get("confidence") === null || record.get("confidence") === undefined
          ? undefined
          : Number(record.get("confidence") as number),
      relationshipHint: (record.get("relationshipHint") as string | null) ?? undefined,
    }));

    const communityCount = new Set(
      episodicNodes.map((node) => node.communityId).filter((value) => value !== undefined && value !== -1)
    ).size;
    const similarityEdgeCount = edges.filter((edge) => edge.type === "SIMILAR_TO").length;
    const semanticEdgeCount = edges.length - similarityEdgeCount;

    return {
      nodes,
      edges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        communityCount,
        episodicNodeCount: episodicNodes.length,
        semanticNodeCount: semanticNodes.length,
        similarityEdgeCount,
        semanticEdgeCount,
      },
    };
  } finally {
    await session.close();
  }
}

async function upsertSemanticEntity(
  session: Session,
  interactionId: string,
  entity: ExtractedEntity,
  timestamp: string
) {
  await session.run(
    `MERGE (s:SemanticNode {entityId: $entityId})
     ON CREATE SET
       s.type = 'semantic',
       s.entityType = $entityType,
       s.canonicalName = $canonicalName,
       s.canonicalKey = $canonicalKey,
       s.aliases = $aliases,
       s.mentionCount = 1,
       s.createdAt = $timestamp,
       s.updatedAt = $timestamp
     ON MATCH SET
       s.entityType = $entityType,
       s.canonicalName = $canonicalName,
       s.canonicalKey = $canonicalKey,
       s.aliases = reduce(acc = coalesce(s.aliases, []), alias IN $aliases |
         CASE
           WHEN alias IS NULL OR trim(alias) = '' OR alias IN acc THEN acc
           ELSE acc + alias
         END
       ),
       s.mentionCount = coalesce(s.mentionCount, 0) + 1,
       s.updatedAt = $timestamp`,
    {
      entityId: entity.entityId,
      entityType: entity.entityType,
      canonicalName: entity.canonicalName,
      canonicalKey: entity.canonicalKey,
      aliases: entity.aliases,
      timestamp,
    }
  );

  const edgeWeight = entity.confidence > 0 ? entity.confidence : 0.7;
  await session.run(
    `MATCH (e:EpisodicNode {nodeId: $interactionId}), (s:SemanticNode {entityId: $entityId})
     MERGE (e)-[r:${entity.relationshipType}]->(s)
     ON CREATE SET
       r.weight = $weight,
       r.confidence = $confidence,
       r.relationshipHint = $relationshipHint,
       r.rawRelationshipType = $rawRelationshipType,
       r.evidence = $evidence,
       r.mentionCount = 1,
       r.createdAt = $timestamp,
       r.updatedAt = $timestamp
     ON MATCH SET
       r.weight = CASE WHEN coalesce(r.weight, 0.0) < $weight THEN $weight ELSE r.weight END,
       r.confidence = CASE WHEN coalesce(r.confidence, 0.0) < $confidence THEN $confidence ELSE r.confidence END,
       r.relationshipHint = coalesce($relationshipHint, r.relationshipHint),
       r.rawRelationshipType = coalesce($rawRelationshipType, r.rawRelationshipType),
       r.evidence = coalesce($evidence, r.evidence),
       r.mentionCount = coalesce(r.mentionCount, 0) + 1,
       r.updatedAt = $timestamp`,
    {
      interactionId,
      entityId: entity.entityId,
      weight: edgeWeight,
      confidence: entity.confidence,
      relationshipHint: entity.relationshipHint,
      rawRelationshipType: entity.rawRelationshipType,
      evidence: entity.evidence,
      timestamp,
    }
  );
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
