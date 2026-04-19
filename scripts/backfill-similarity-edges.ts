import neo4j from "neo4j-driver";

import "../src/server/env.js";

import { closeNeo4j, getNeo4jDriver } from "../src/server/db/neo4j.js";
import { normalizeEmbedding } from "../src/server/embeddings.js";
import {
  buildSemanticEdgeProperties,
  parseStoredSemanticEntities,
} from "../src/server/services/semanticGraphAttributes.js";

const BACKFILL_THRESHOLD = 0.72;
const BATCH_SIZE = 50;

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

async function main() {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    // 1. Fetch all existing SIMILAR_TO edges so we can skip pairs that already exist
    console.log("Loading existing SIMILAR_TO edges...");
    const existingEdgeResult = await session.run(
      `MATCH (a:EpisodicNode)-[r:SIMILAR_TO]-(b:EpisodicNode)
       WHERE a.nodeId < b.nodeId
       RETURN a.nodeId AS source, b.nodeId AS target`
    );

    const existingEdges = new Set<string>();
    for (const record of existingEdgeResult.records) {
      const source = String(record.get("source") ?? "");
      const target = String(record.get("target") ?? "");
      existingEdges.add(`${source}__${target}`);
    }
    console.log(`Found ${existingEdges.size} existing SIMILAR_TO edges.`);

    // 2. Load all EpisodicNodes that have embeddings
    console.log("Loading EpisodicNodes with embeddings...");
    const nodeResult = await session.run(
      `MATCH (n:EpisodicNode) WHERE n.embedding IS NOT NULL
       RETURN n.nodeId AS nodeId,
              n.embedding AS embedding,
              coalesce(n.semanticPayloadJson, '[]') AS semanticPayloadJson`
    );

    const allNodes = nodeResult.records.map((record) => ({
      nodeId: String(record.get("nodeId") ?? ""),
      embedding: normalizeEmbedding(record.get("embedding") as number[]),
      semanticPayloadJson: String(record.get("semanticPayloadJson") ?? "[]"),
    }));

    // Sort by nodeId so that index i < index j always means nodeId[i] < nodeId[j]
    allNodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    console.log(`Loaded ${allNodes.length} nodes. Starting pairwise comparison...`);

    let edgesCreated = 0;
    let pairsChecked = 0;
    const updatedAt = new Date().toISOString();

    // 3. Process outer loop in batches of BATCH_SIZE
    for (let batchStart = 0; batchStart < allNodes.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, allNodes.length);
      const batchNodes = allNodes.slice(batchStart, batchEnd);

      // Collect new edges found in this batch
      const newEdgeRows: Array<{
        sourceId: string;
        targetId: string;
        weight: number;
        cosineWeight: number;
        semanticOverlapWeight: number;
        combinedWeight: number;
        sharedEntityCount: unknown;
        sharedEntityKeys: string[];
        sharedEntityNames: string[];
        sharedEntityTypes: string[];
        semanticOverlapJson: string;
        updatedAt: string;
      }> = [];

      for (let bi = 0; bi < batchNodes.length; bi++) {
        const nodeA = batchNodes[bi];
        // The global index of nodeA in allNodes is batchStart + bi
        const globalIndexA = batchStart + bi;

        // Compare nodeA against every node that comes after it in the sorted array
        for (let j = globalIndexA + 1; j < allNodes.length; j++) {
          const nodeB = allNodes[j];
          pairsChecked++;

          // nodeA.nodeId < nodeB.nodeId is guaranteed by sort order
          const edgeKey = `${nodeA.nodeId}__${nodeB.nodeId}`;
          if (existingEdges.has(edgeKey)) {
            continue;
          }

          const sim = cosineSimilarity(nodeA.embedding, nodeB.embedding);
          if (sim < BACKFILL_THRESHOLD) {
            continue;
          }

          const sourceEntities = parseStoredSemanticEntities(nodeA.semanticPayloadJson);
          const targetEntities = parseStoredSemanticEntities(nodeB.semanticPayloadJson);
          const edgeProperties = buildSemanticEdgeProperties(sourceEntities, targetEntities, sim);

          newEdgeRows.push({
            sourceId: nodeA.nodeId,
            targetId: nodeB.nodeId,
            weight: edgeProperties.weight,
            cosineWeight: edgeProperties.cosineWeight,
            semanticOverlapWeight: edgeProperties.semanticOverlapWeight,
            combinedWeight: edgeProperties.combinedWeight,
            sharedEntityCount: neo4j.int(edgeProperties.sharedEntityCount),
            sharedEntityKeys: edgeProperties.sharedEntityKeys,
            sharedEntityNames: edgeProperties.sharedEntityNames,
            sharedEntityTypes: edgeProperties.sharedEntityTypes,
            semanticOverlapJson: edgeProperties.semanticOverlapJson,
            updatedAt,
          });

          // Add to the set so we don't try to create it again if encountered from the other direction
          existingEdges.add(edgeKey);
        }
      }

      // Write this batch's new edges
      if (newEdgeRows.length > 0) {
        await session.run(
          `UNWIND $rows AS row
           MATCH (a:EpisodicNode {nodeId: row.sourceId}), (b:EpisodicNode {nodeId: row.targetId})
           MERGE (a)-[r:SIMILAR_TO]-(b)
           SET r.weight = row.weight,
               r.cosineWeight = row.cosineWeight,
               r.semanticOverlapWeight = row.semanticOverlapWeight,
               r.combinedWeight = row.combinedWeight,
               r.sharedEntityCount = row.sharedEntityCount,
               r.sharedEntityKeys = row.sharedEntityKeys,
               r.sharedEntityNames = row.sharedEntityNames,
               r.sharedEntityTypes = row.sharedEntityTypes,
               r.semanticOverlapJson = row.semanticOverlapJson,
               r.updatedAt = row.updatedAt`,
          { rows: newEdgeRows }
        );
        edgesCreated += newEdgeRows.length;
      }

      console.log(
        `Processed nodes ${batchStart + 1}–${batchEnd} of ${allNodes.length} ` +
        `(${pairsChecked} pairs checked, ${edgesCreated} edges created so far)`
      );
    }

    console.log(
      `Backfill complete. Checked ${pairsChecked} pairs, created ${edgesCreated} new SIMILAR_TO edges.`
    );
  } finally {
    await session.close();
    await closeNeo4j();
  }
}

main().catch((error) => {
  console.error("Similarity edge backfill failed:", error);
  process.exit(1);
});
