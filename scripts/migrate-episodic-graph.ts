import neo4j from "neo4j-driver";

import "../src/server/env.js";

import { closeNeo4j, getNeo4jDriver } from "../src/server/db/neo4j.js";
import {
  buildSemanticEdgeProperties,
  buildSemanticNodePropertiesFromStored,
  type StoredSemanticEntity,
} from "../src/server/services/semanticGraphAttributes.js";

async function main() {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    console.log("Reading episodic nodes and legacy semantic links...");
    const nodeResult = await session.run(
      `MATCH (e:EpisodicNode)
       OPTIONAL MATCH (e)-[r]->(s:SemanticNode)
       RETURN e.nodeId AS nodeId,
              collect(
                CASE
                  WHEN s IS NULL THEN null
                  ELSE {
                    entityId: s.entityId,
                    entityType: s.entityType,
                    canonicalName: s.canonicalName,
                    aliases: coalesce(s.aliases, []),
                    relationshipType: type(r),
                    relationshipHint: r.relationshipHint,
                    confidence: coalesce(r.confidence, 0.0),
                    evidence: r.evidence,
                    mentionCount: coalesce(r.mentionCount, 1)
                  }
                END
              ) AS rawEntities`
    );

    const nodeRows = nodeResult.records.map((record) => {
      const nodeId = String(record.get("nodeId") ?? "");
      const rawEntities = ((record.get("rawEntities") as Array<Record<string, unknown> | null>) ?? [])
        .filter((entity): entity is Record<string, unknown> => entity !== null)
        .map((entity) => ({
          entityId: String(entity.entityId ?? ""),
          entityType: String(entity.entityType ?? "topic") as StoredSemanticEntity["entityType"],
          canonicalName: String(entity.canonicalName ?? ""),
          aliases: Array.isArray(entity.aliases) ? entity.aliases.map((value) => String(value)) : [],
          relationshipType: String(entity.relationshipType ?? "RELATED_TO_ENTITY") as StoredSemanticEntity["relationshipType"],
          relationshipHint: entity.relationshipHint == null ? null : String(entity.relationshipHint),
          confidence: Number(entity.confidence ?? 0),
          evidence: entity.evidence == null ? null : String(entity.evidence),
          mentionCount: Math.max(1, Number(entity.mentionCount ?? 1)),
        }))
        .filter((entity) => entity.entityId && entity.canonicalName);
      const semanticNodeProperties = buildSemanticNodePropertiesFromStored(rawEntities);

      return {
        nodeId,
        semanticEntityCount: neo4j.int(semanticNodeProperties.semanticEntityCount),
        semanticEntityKeys: semanticNodeProperties.semanticEntityKeys,
        semanticEntityNames: semanticNodeProperties.semanticEntityNames,
        semanticEntityTypes: semanticNodeProperties.semanticEntityTypes,
        semanticRelationshipTypes: semanticNodeProperties.semanticRelationshipTypes,
        semanticMaxConfidence: semanticNodeProperties.semanticMaxConfidence,
        semanticPayloadJson: semanticNodeProperties.semanticPayloadJson,
      };
    });

    if (nodeRows.length > 0) {
      await session.run(
        `UNWIND $rows AS row
         MATCH (e:EpisodicNode {nodeId: row.nodeId})
         SET e.semanticEntityCount = row.semanticEntityCount,
             e.semanticEntityKeys = row.semanticEntityKeys,
             e.semanticEntityNames = row.semanticEntityNames,
             e.semanticEntityTypes = row.semanticEntityTypes,
             e.semanticRelationshipTypes = row.semanticRelationshipTypes,
             e.semanticMaxConfidence = row.semanticMaxConfidence,
             e.semanticPayloadJson = row.semanticPayloadJson`,
        { rows: nodeRows }
      );
    }

    console.log(`Updated semantic attributes for ${nodeRows.length} episodic nodes.`);

    console.log("Recomputing similarity edge overlap attributes...");
    const edgeResult = await session.run(
      `MATCH (a:EpisodicNode)-[r:SIMILAR_TO]-(b:EpisodicNode)
       WHERE a.nodeId < b.nodeId
       RETURN a.nodeId AS sourceId,
              b.nodeId AS targetId,
              coalesce(r.cosineWeight, r.weight, 0.0) AS cosineWeight,
              coalesce(a.semanticPayloadJson, '[]') AS sourcePayload,
              coalesce(b.semanticPayloadJson, '[]') AS targetPayload`
    );

    const edgeRows = edgeResult.records.map((record) => {
      const sourcePayload = JSON.parse(String(record.get("sourcePayload") ?? "[]")) as StoredSemanticEntity[];
      const targetPayload = JSON.parse(String(record.get("targetPayload") ?? "[]")) as StoredSemanticEntity[];
      const edgeProperties = buildSemanticEdgeProperties(
        sourcePayload,
        targetPayload,
        Number(record.get("cosineWeight") ?? 0)
      );

      return {
        sourceId: String(record.get("sourceId") ?? ""),
        targetId: String(record.get("targetId") ?? ""),
        weight: edgeProperties.weight,
        cosineWeight: edgeProperties.cosineWeight,
        semanticOverlapWeight: edgeProperties.semanticOverlapWeight,
        combinedWeight: edgeProperties.combinedWeight,
        sharedEntityCount: neo4j.int(edgeProperties.sharedEntityCount),
        sharedEntityKeys: edgeProperties.sharedEntityKeys,
        sharedEntityNames: edgeProperties.sharedEntityNames,
        sharedEntityTypes: edgeProperties.sharedEntityTypes,
        semanticOverlapJson: edgeProperties.semanticOverlapJson,
      };
    });

    if (edgeRows.length > 0) {
      await session.run(
        `UNWIND $rows AS row
         MATCH (a:EpisodicNode {nodeId: row.sourceId})-[r:SIMILAR_TO]-(b:EpisodicNode {nodeId: row.targetId})
         WHERE a.nodeId < b.nodeId
         SET r.weight = row.weight,
             r.cosineWeight = row.cosineWeight,
             r.semanticOverlapWeight = row.semanticOverlapWeight,
             r.combinedWeight = row.combinedWeight,
             r.sharedEntityCount = row.sharedEntityCount,
             r.sharedEntityKeys = row.sharedEntityKeys,
             r.sharedEntityNames = row.sharedEntityNames,
             r.sharedEntityTypes = row.sharedEntityTypes,
             r.semanticOverlapJson = row.semanticOverlapJson,
             r.updatedAt = datetime().toString()`,
        { rows: edgeRows }
      );
    }

    console.log(`Updated overlap attributes for ${edgeRows.length} similarity edges.`);

    console.log("Removing legacy semantic edges and nodes...");
    await session.run(`MATCH (:EpisodicNode)-[r]->(:SemanticNode) DELETE r`);
    await session.run(`MATCH (s:SemanticNode) DETACH DELETE s`);

    console.log("Dropping legacy semantic indexes and constraints if they still exist...");
    await session.run(`DROP INDEX semantic_node_lookup IF EXISTS`);
    await session.run(`DROP CONSTRAINT semantic_node_id IF EXISTS`);

    console.log("Episodic-only Neo4j migration completed.");
  } finally {
    await session.close();
    await closeNeo4j();
  }
}

main().catch((error) => {
  console.error("Episodic graph migration failed:", error);
  process.exit(1);
});