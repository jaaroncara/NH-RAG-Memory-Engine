import { getNeo4jDriver } from "../db/neo4j.js";
import { getProvider } from "../providers/index.js";
import { storeFact } from "./ltmService.js";
import { createJob, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";

const SALIENCE_PERCENTILE = 25;
const MIN_COMMUNITY_SIZE = 3;

export async function runSleepCycle(): Promise<{
  pruned: number;
  consolidated: number;
} | null> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  const jobId = await createJob({
    jobType: "sleep_cycle",
    stage: "project_graph",
    metadata: {},
  });

  try {
    await markJobRunning(jobId, "project_graph", 5);
    await recordPipelineEvent({
      jobId,
      stage: "project_graph",
      message: "Sleep cycle started",
    });

    // Check node count
    const countResult = await session.run(
      "MATCH (n:EpisodicNode) RETURN count(n) AS cnt"
    );
    const nodeCount = countResult.records[0].get("cnt").toNumber();
    if (nodeCount < 2) {
      await markJobCompleted(jobId, "completed", 100, { pruned: 0, consolidated: 0 });
      await recordPipelineEvent({
        jobId,
        stage: "completed",
        message: "Sleep cycle skipped because there are fewer than two MTM nodes",
      });
      return null;
    }

    // ------------------------------------------------------------------
    // 1. Project the in-memory graph for GDS algorithms
    // ------------------------------------------------------------------
    const graphName = `nhrag_sleep_${Date.now()}`;

    await session.run(
      `CALL gds.graph.project(
        $graphName,
        'EpisodicNode',
        { SIMILAR_TO: { orientation: 'UNDIRECTED', properties: ['weight'] } }
      )`,
      { graphName }
    );
    await markJobRunning(jobId, "rank_nodes", 25);

    // ------------------------------------------------------------------
    // 2. PageRank (Synaptic Pruning)
    // ------------------------------------------------------------------
    const prResult = await session.run(
      `CALL gds.pageRank.stream($graphName, {
        relationshipWeightProperty: 'weight',
        dampingFactor: 0.85
      })
      YIELD nodeId, score
      RETURN gds.util.asNode(nodeId).nodeId AS nid, score
      ORDER BY score ASC`,
      { graphName }
    );

    const scores = prResult.records.map((r) => ({
      nid: r.get("nid") as string,
      score: r.get("score") as number,
    }));

    // Write PageRank back to nodes for reference
    await session.run(
      `CALL gds.pageRank.write($graphName, {
        relationshipWeightProperty: 'weight',
        dampingFactor: 0.85,
        writeProperty: 'pageRank'
      })`,
      { graphName }
    );

    // Calculate pruning threshold (bottom 25th percentile)
    const sorted = scores.map((s) => s.score).sort((a, b) => a - b);
    const thresholdIdx = Math.floor(
      (SALIENCE_PERCENTILE / 100) * sorted.length
    );
    const threshold = sorted[thresholdIdx] ?? 0;
    const nodesToPrune = scores
      .filter((s) => s.score < threshold)
      .map((s) => s.nid);
    await recordPipelineEvent({
      jobId,
      stage: "rank_nodes",
      message: "Calculated PageRank scores",
      payload: {
        nodeCount,
        threshold,
        nodesToPrune: nodesToPrune.length,
      },
    });

    // ------------------------------------------------------------------
    // 3. Louvain Community Detection
    // ------------------------------------------------------------------
    await session.run(
      `CALL gds.louvain.write($graphName, {
        relationshipWeightProperty: 'weight',
        writeProperty: 'communityId'
      })`,
      { graphName }
    );
    await markJobRunning(jobId, "cluster_communities", 50);

    // Read communities (excluding pruned nodes)
    const commResult = await session.run(
      `MATCH (n:EpisodicNode)
       WHERE n.communityId IS NOT NULL AND NOT n.nodeId IN $pruned
       RETURN n.communityId AS cid, collect(n.nodeId) AS nodeIds, collect(n.content) AS contents`,
      { pruned: nodesToPrune }
    );

    // ------------------------------------------------------------------
    // 4. Distill surviving communities to LTM
    // ------------------------------------------------------------------
    const provider = getProvider();
    let consolidatedCount = 0;
    await markJobRunning(jobId, "distill_facts", 70);

    for (const record of commResult.records) {
      const nodeIds = record.get("nodeIds") as string[];
      const contents = record.get("contents") as string[];

      if (nodeIds.length < MIN_COMMUNITY_SIZE) continue;

      const communityContent = contents.join("\n");
      const distilledFact = await provider.generate(
        `Synthesize the following episodic memories into a single, dense, generalized semantic fact. Strip away specific dates and verbatim quotes. Focus on the underlying truth or user preference.\n\nMemories:\n${communityContent}`
      );

      if (distilledFact) {
        const embedding = await provider.embed(distilledFact);
        await storeFact(distilledFact, embedding, nodeIds, {
          communitySize: nodeIds.length,
        });
        consolidatedCount++;
      }
    }

    // ------------------------------------------------------------------
    // 5. Execute Synaptic Pruning
    // ------------------------------------------------------------------
    if (nodesToPrune.length > 0) {
      await session.run(
        `MATCH (n:EpisodicNode) WHERE n.nodeId IN $ids DETACH DELETE n`,
        { ids: nodesToPrune }
      );
    }
    await markJobRunning(jobId, "cleanup", 95);

    // ------------------------------------------------------------------
    // 6. Drop the projected graph
    // ------------------------------------------------------------------
    await session.run(`CALL gds.graph.drop($graphName)`, { graphName });

    await recordPipelineEvent({
      jobId,
      stage: "cleanup",
      message: "Sleep cycle completed",
      payload: { pruned: nodesToPrune.length, consolidated: consolidatedCount },
    });
    await markJobCompleted(jobId, "completed", 100, {
      pruned: nodesToPrune.length,
      consolidated: consolidatedCount,
    });

    return { pruned: nodesToPrune.length, consolidated: consolidatedCount };
  } catch (error) {
    await markJobFailed(jobId, "failed", error instanceof Error ? error.message : String(error));
    await recordPipelineEvent({
      jobId,
      stage: "failed",
      level: "error",
      message: "Sleep cycle failed",
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    await session.close();
  }
}
