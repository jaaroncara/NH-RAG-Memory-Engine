/**
 * backfill-bipartite-graph.ts
 *
 * Backfills existing EpisodicNodes (created before the bipartite graph refactor)
 * with the ChunkNode label, TopicNode nodes, and MENTIONS edges.
 *
 * Run once after deploying the bipartite MTM refactor:
 *   npx tsx scripts/backfill-bipartite-graph.ts
 *
 * Safe to re-run: MERGE semantics on TopicNode and MENTIONS edges are idempotent.
 */

import "../src/server/env.js";

import { closeNeo4j, getNeo4jDriver } from "../src/server/db/neo4j.js";
import { parseStoredSemanticEntities } from "../src/server/services/semanticGraphAttributes.js";

const BATCH_SIZE = 500;

async function main() {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    // Count nodes that need backfilling (have no ChunkNode label and no MENTIONS edges)
    const countResult = await session.run(
      `MATCH (n:EpisodicNode)
       WHERE NOT n:ChunkNode AND NOT (n)-[:MENTIONS]->(:TopicNode)
       RETURN count(n) AS pending`
    );
    const pending = countResult.records[0].get("pending").toNumber();
    console.log(`Nodes needing backfill: ${pending}`);

    if (pending === 0) {
      console.log("Nothing to backfill.");
      return;
    }

    // Also add ChunkNode label to all existing EpisodicNodes missing it,
    // regardless of whether they have MENTIONS edges yet.
    console.log("Adding ChunkNode label to unlabelled EpisodicNodes...");
    await session.run(
      `MATCH (n:EpisodicNode)
       WHERE NOT n:ChunkNode
       SET n:ChunkNode, n.type = 'chunk'`
    );
    console.log("ChunkNode labels applied.");

    let processed = 0;
    let skip = 0;
    let totalTopicsCreated = 0;
    let totalMentionEdges = 0;

    console.log("Backfilling TopicNodes and MENTIONS edges...");

    while (true) {
      // Fetch a batch of nodes that still have no MENTIONS edges
      const batchResult = await session.run(
        `MATCH (n:ChunkNode)
         WHERE NOT (n)-[:MENTIONS]->(:TopicNode)
           AND n.semanticPayloadJson IS NOT NULL
           AND n.semanticPayloadJson <> '[]'
         RETURN n.nodeId AS nodeId, n.semanticPayloadJson AS semanticPayloadJson
         ORDER BY n.nodeId
         SKIP $skip
         LIMIT $batchSize`,
        { skip, batchSize: BATCH_SIZE }
      );

      if (batchResult.records.length === 0) break;

      for (const record of batchResult.records) {
        const nodeId = record.get("nodeId") as string;
        const rawPayload = record.get("semanticPayloadJson") as string;
        const entities = parseStoredSemanticEntities(rawPayload);

        if (entities.length === 0) continue;

        const topicParams = entities.map((entity) => ({
          topicId: entity.entityId,
          entityType: entity.entityType,
          canonicalName: entity.canonicalName,
          aliases: entity.aliases,
          confidence: entity.confidence,
          mentionCount: Math.max(entity.mentionCount, 1),
          relationshipType: entity.relationshipType,
        }));

        const backfilledAt = new Date().toISOString();

        await session.run(
          `UNWIND $topics AS topic
           MERGE (t:TopicNode { topicId: topic.topicId })
           ON CREATE SET
             t.entityType = topic.entityType,
             t.canonicalName = topic.canonicalName,
             t.aliases = topic.aliases,
             t.mentionCount = topic.mentionCount,
             t.confidence = topic.confidence,
             t.lastMentionedAt = $backfilledAt
           ON MATCH SET
             t.mentionCount = t.mentionCount + topic.mentionCount,
             t.confidence = CASE WHEN topic.confidence > t.confidence THEN topic.confidence ELSE t.confidence END,
             t.lastMentionedAt = $backfilledAt,
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
          { topics: topicParams, nodeId, backfilledAt }
        );

        totalTopicsCreated += entities.length;
        totalMentionEdges += entities.length;
        processed++;
      }

      console.log(`  Processed ${processed} / ${pending} nodes (batch boundary: ${skip + BATCH_SIZE})`);
      skip += BATCH_SIZE;
    }

    // Final stats
    const statsResult = await session.run(
      `MATCH (t:TopicNode) RETURN count(t) AS topicCount
       UNION ALL
       MATCH ()-[m:MENTIONS]->() RETURN count(m) AS topicCount`
    );
    const [topicCount, mentionCount] = statsResult.records.map((r) => r.get("topicCount").toNumber());

    console.log(`\nBackfill complete.`);
    console.log(`  EpisodicNodes processed: ${processed}`);
    console.log(`  Total TopicNodes in graph: ${topicCount}`);
    console.log(`  Total MENTIONS edges in graph: ${mentionCount}`);
  } finally {
    await session.close();
    await closeNeo4j();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
