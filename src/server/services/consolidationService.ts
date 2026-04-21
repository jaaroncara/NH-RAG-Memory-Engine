import neo4j from "neo4j-driver";
import { getNeo4jDriver } from "../db/neo4j.js";
import { getProvider } from "../providers/index.js";
import { storeFact, condenseLtmFacts } from "./ltmService.js";
import { pruneStm } from "./stmService.js";
import { pruneStaleTopicNodes } from "./mtmService.js";
import { createJob, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";
import { CONCEPT_HIERARCHY } from "../ontology/conceptHierarchy.js";
import { getPruningConfig } from "../config/pruningConfig.js";

const SALIENCE_PERCENTILE = 25;
const MIN_COMMUNITY_SIZE = 2;
const MIN_NODES_FOR_PRUNING = 8;
const MAX_PRUNE_FRACTION = 0.20;
const MIN_SCORE_VARIANCE_RATIO = 0.05;
const KNN_SIMILARITY_CUTOFF = 0.72;
const KNN_TOP_K = 15;

interface PageRankScore {
  graphNodeId: string;
  score: number;
}

interface SemanticCommunityEntity {
  entityId: string;
  entityType: string;
  canonicalName: string;
  mentionCount: number;
}

interface SemanticCommunityRelation {
  relationshipType: string;
  entityType: string;
  canonicalName: string;
  confidence: number;
  relationshipHint?: string | null;
}

interface CommunityRecord {
  cid: unknown;
  nodeIds: string[];
  contents: string[];
}

interface CommunityTopicRow {
  topicId: string;
  entityType: string;
  canonicalName: string;
  totalMentionCount: number;
}

interface TopicRelTypeRow {
  topicId: string;
  topRelTypes: Array<{ relationshipType: string; count: number }>;
}

export interface SleepCycleLaunchResult {
  jobId: string;
  status: "queued";
  stage: "project_graph";
  progress: 0;
}

const SLEEP_CYCLE_PROGRESS = {
  clearEdges:           5,
  knnProject:           8,
  knnWrite:            18,
  analyticsProject:    22,
  rankNodesStart:      24,
  rankNodesComplete:   42,
  clusterCommunities:  55,
  distillStart:        62,
  distillComplete:     92,
  cleanup:             96,
  topicPrune:          97,
  stmPrune:            98,
  ltmCondense:         99,
  completed:          100,
} as const;

export async function runSleepCycle(): Promise<SleepCycleLaunchResult> {
  const jobId = await createJob({
    jobType: "sleep_cycle",
    stage: "project_graph",
    metadata: {},
  });

  queueMicrotask(() => {
    void processSleepCycleJob(jobId);
  });

  return {
    jobId,
    status: "queued",
    stage: "project_graph",
    progress: 0,
  };
}

async function processSleepCycleJob(jobId: string): Promise<void> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  const ts = Date.now();
  const knnGraphName       = `nhrag_knn_${ts}`;
  const analyticsGraphName = `nhrag_analytics_${ts}`;
  const louvainGraphName   = `nhrag_louvain_${ts}`;
  let knnGraphProjected       = false;
  let analyticsGraphProjected = false;
  let louvainGraphProjected   = false;

  try {
    await markJobRunning(jobId, "clear_edges", SLEEP_CYCLE_PROGRESS.clearEdges);

    // Check node count
    const countResult = await session.run(
      "MATCH (n:MemoryNode) RETURN count(n) AS cnt"
    );
    const nodeCount = countResult.records[0].get("cnt").toNumber();
    if (nodeCount < 2) {
      await markJobCompleted(jobId, "completed", 100, { pruned: 0, consolidated: 0 });
      await recordPipelineEvent({
        jobId,
        stage: "completed",
        message: "Sleep cycle skipped because there are fewer than two MTM nodes",
        payload: { progress: SLEEP_CYCLE_PROGRESS.completed, pruned: 0, consolidated: 0 },
      });
      return;
    }

    // ------------------------------------------------------------------
    // Step 0. Clear all existing SIMILARITY edges
    // GDS KNN write creates new edges; it does not upsert stale ones.
    // ------------------------------------------------------------------
    await session.run("MATCH ()-[r:SIMILARITY]-() DELETE r");
    await recordPipelineEvent({
      jobId,
      stage: "clear_edges",
      message: "Cleared existing SIMILARITY edges before KNN rebuild",
      payload: { progress: SLEEP_CYCLE_PROGRESS.clearEdges, nodeCount },
    });

    // ------------------------------------------------------------------
    // Steps 1-3. KNN graph projection → build SIMILARITY edges via GDS
    // ------------------------------------------------------------------
    await markJobRunning(jobId, "knn_project", SLEEP_CYCLE_PROGRESS.knnProject);
    await session.run(
      `CALL gds.graph.project($graphName,
         { MemoryNode: { properties: ['embedding'] } },
         '*'
       )`,
      { graphName: knnGraphName }
    );
    knnGraphProjected = true;

    await markJobRunning(jobId, "knn_write", SLEEP_CYCLE_PROGRESS.knnWrite);
    const knnResult = await session.run(
      `CALL gds.knn.write($graphName, {
         nodeProperties:        ['embedding'],
         topK:                  $topK,
         sampleRate:            1.0,
         randomJoins:           10,
         writeRelationshipType: 'SIMILARITY',
         writeProperty:         'weight',
         similarityCutoff:      $cutoff,
         concurrency:           4
       })
       YIELD nodesCompared, relationshipsWritten`,
      { graphName: knnGraphName, topK: neo4j.int(KNN_TOP_K), cutoff: KNN_SIMILARITY_CUTOFF }
    );
    const nodesCompared       = knnResult.records[0].get("nodesCompared").toNumber();
    const relationshipsWritten = knnResult.records[0].get("relationshipsWritten").toNumber();

    // Stamp updatedAt on new edges
    const now = new Date().toISOString();
    await session.run(
      "MATCH ()-[r:SIMILARITY]-() WHERE r.updatedAt IS NULL SET r.updatedAt = $now",
      { now }
    );

    await session.run(`CALL gds.graph.drop($graphName)`, { graphName: knnGraphName });
    knnGraphProjected = false;

    await recordPipelineEvent({
      jobId,
      stage: "knn_write",
      message: `KNN complete: ${nodesCompared} nodes compared, ${relationshipsWritten} SIMILARITY edges written`,
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.knnWrite,
        nodesCompared,
        relationshipsWritten,
        cutoff: KNN_SIMILARITY_CUTOFF,
        topK: KNN_TOP_K,
      },
    });

    if (relationshipsWritten === 0) {
      await markJobCompleted(jobId, "completed", 100, { pruned: 0, consolidated: 0 });
      await recordPipelineEvent({
        jobId,
        stage: "completed",
        message: "Sleep cycle skipped: no SIMILARITY edges above threshold — all nodes are below cosine cutoff",
        payload: { progress: SLEEP_CYCLE_PROGRESS.completed },
      });
      return;
    }

    // ------------------------------------------------------------------
    // Steps 4-8. Analytics graph → PageRank → compute τ → identify prune set
    // ------------------------------------------------------------------
    await markJobRunning(jobId, "rank_nodes", SLEEP_CYCLE_PROGRESS.analyticsProject);
    await session.run(
      `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
      {
        graphName: analyticsGraphName,
        nodeLabels: ["MemoryNode"],
        relationshipProjection: { SIMILARITY: { orientation: "UNDIRECTED", properties: ["weight"] } },
      }
    );
    analyticsGraphProjected = true;

    await markJobRunning(jobId, "rank_nodes", SLEEP_CYCLE_PROGRESS.rankNodesStart);
    const prResult = await session.run(
      `CALL gds.pageRank.stream($graphName, {
         relationshipWeightProperty: 'weight',
         dampingFactor: 0.85,
         maxIterations: 40
       })
       YIELD nodeId, score
       RETURN gds.util.asNode(nodeId).nodeId AS graphNodeId, score
       ORDER BY score ASC`,
      { graphName: analyticsGraphName }
    );

    const scores: PageRankScore[] = prResult.records.map((r) => ({
      graphNodeId: String(r.get("graphNodeId") ?? ""),
      score: Number(r.get("score") ?? 0),
    }));
    const episodicScores = scores.filter((s) => s.graphNodeId.length > 0);

    await session.run(
      `CALL gds.pageRank.write($graphName, {
         relationshipWeightProperty: 'weight',
         dampingFactor: 0.85,
         maxIterations: 40,
         writeProperty: 'pageRank'
       })`,
      { graphName: analyticsGraphName }
    );
    await markJobRunning(jobId, "rank_nodes", SLEEP_CYCLE_PROGRESS.rankNodesComplete);

    // Compute τ with adaptive guards
    const sorted = episodicScores.map((s) => s.score).sort((a, b) => a - b);
    let nodesToPrune: string[] = [];
    let threshold = 0;
    let pruningSkipReason: string | null = null;

    if (episodicScores.length < MIN_NODES_FOR_PRUNING) {
      pruningSkipReason = `graph has only ${episodicScores.length} nodes (minimum ${MIN_NODES_FOR_PRUNING})`;
    } else {
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const scoreRange = sorted[sorted.length - 1] - sorted[0];
      if (scoreRange < MIN_SCORE_VARIANCE_RATIO * mean) {
        pruningSkipReason = "PageRank scores are nearly uniform — no clear low-salience nodes";
      } else {
        const thresholdIdx = Math.floor((SALIENCE_PERCENTILE / 100) * sorted.length);
        threshold = sorted[thresholdIdx] ?? 0;
        const candidates = episodicScores
          .filter((s) => s.score < threshold)
          .map((s) => s.graphNodeId);
        const maxPrunable = Math.floor(MAX_PRUNE_FRACTION * episodicScores.length);
        nodesToPrune = candidates.slice(0, maxPrunable);
      }
    }

    await recordPipelineEvent({
      jobId,
      stage: "rank_nodes",
      message: pruningSkipReason
        ? `PageRank computed but pruning skipped: ${pruningSkipReason}`
        : `PageRank computed: τ=${threshold.toFixed(4)}, ${nodesToPrune.length} nodes flagged for pruning`,
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.rankNodesComplete,
        nodeCount,
        episodicNodeCount: episodicScores.length,
        threshold,
        nodesToPrune: nodesToPrune.length,
        pruningSkipReason,
      },
    });

    await session.run(`CALL gds.graph.drop($graphName)`, { graphName: analyticsGraphName });
    analyticsGraphProjected = false;

    // ------------------------------------------------------------------
    // Step 9. Synaptic pruning — BEFORE Louvain to keep community quality high
    // ------------------------------------------------------------------
    if (nodesToPrune.length > 0) {
      await session.run(
        `MATCH (n:MemoryNode) WHERE n.nodeId IN $ids DETACH DELETE n`,
        { ids: nodesToPrune }
      );
    }
    // Always clean up orphaned TopicNodes
    try {
      await session.run(
        `MATCH (t:TopicNode)
         WHERE NOT (t)<-[:MENTIONS]-(:MemoryNode)
         DETACH DELETE t`
      );
    } catch (orphanError) {
      console.warn("[consolidationService] Orphaned TopicNode cleanup failed (non-fatal):", orphanError);
    }

    // ------------------------------------------------------------------
    // Steps 10-12. Louvain graph → community detection on the clean graph
    // ------------------------------------------------------------------
    await markJobRunning(jobId, "cluster_communities", SLEEP_CYCLE_PROGRESS.clusterCommunities);
    await session.run(
      `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
      {
        graphName: louvainGraphName,
        nodeLabels: ["MemoryNode"],
        relationshipProjection: {
          SIMILARITY: { orientation: "UNDIRECTED", properties: ["weight"] },
        },
      }
    );
    louvainGraphProjected = true;

    try {
      await session.run(
        `CALL gds.leiden.write($graphName, {
           relationshipWeightProperty: 'weight',
           writeProperty: 'communityId',
           gamma: 2.0,
           theta: 0.1
         })`,
        { graphName: louvainGraphName }
      );
    } catch (error) {
      console.warn("gds.leiden not available, falling back to gds.louvain:", error);
      await session.run(
        `CALL gds.louvain.write($graphName, {
           relationshipWeightProperty: 'weight',
           writeProperty: 'communityId',
           tolerance: 0.0001,
           maxIterations: 20,
           resolution: 2.0
         })`,
        { graphName: louvainGraphName }
      );
    }

    await session.run(`CALL gds.graph.drop($graphName)`, { graphName: louvainGraphName });
    louvainGraphProjected = false;

    // ------------------------------------------------------------------
    // Steps 13-14. Read communities — no mergeBridgedCommunities
    // ------------------------------------------------------------------
    const commResult = await session.run(
      `MATCH (n:MemoryNode)
       WHERE n.communityId IS NOT NULL AND NOT n.nodeId IN $pruned
       WITH n.communityId AS cid,
            collect(n.nodeId)  AS nodeIds,
            collect(n.content) AS contents
       RETURN cid, nodeIds, contents
       ORDER BY cid`,
      { pruned: nodesToPrune }
    );

    const communityRecords: CommunityRecord[] = commResult.records.map((record) => ({
      cid: record.get("cid"),
      nodeIds: record.get("nodeIds") as string[],
      contents: record.get("contents") as string[],
    }));
    const eligibleCommunities = communityRecords.filter(
      (record) => record.nodeIds.length >= MIN_COMMUNITY_SIZE
    );

    await recordPipelineEvent({
      jobId,
      stage: "cluster_communities",
      message: "Clustered MTM nodes into candidate communities",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.clusterCommunities,
        candidateCommunities: commResult.records.length,
        eligibleCommunities: eligibleCommunities.length,
      },
    });

    // ------------------------------------------------------------------
    // Step 15. Distill surviving communities to LTM
    // ------------------------------------------------------------------
    const provider = getProvider();
    let consolidatedCount = 0;
    await markJobRunning(jobId, "distill_facts", SLEEP_CYCLE_PROGRESS.distillStart);
    await recordPipelineEvent({
      jobId,
      stage: "distill_facts",
      message:
        eligibleCommunities.length > 0
          ? `Preparing to distill ${eligibleCommunities.length} MTM communities into LTM facts`
          : "No MTM communities met the minimum size for LTM distillation",
      payload: {
        progress: eligibleCommunities.length > 0 ? SLEEP_CYCLE_PROGRESS.distillStart : SLEEP_CYCLE_PROGRESS.distillComplete,
        eligibleCommunities: eligibleCommunities.length,
      },
    });
    if (eligibleCommunities.length === 0) {
      await markJobRunning(jobId, "distill_facts", SLEEP_CYCLE_PROGRESS.distillComplete);
    }

    let processedCommunities = 0;
    let lastDistillEventPercent = -1;
    for (const record of eligibleCommunities) {
      const communityId = record.cid;
      const nodeIds = record.nodeIds;
      const contents = record.contents;

      // Fetch topic context exclusively from bipartite MENTIONS edges
      const topicContextResult = await session.run(
        `MATCH (c:MemoryNode)-[m:MENTIONS]->(t:TopicNode)
         WHERE c.nodeId IN $nodeIds AND NOT c.nodeId IN $pruned
         RETURN t.topicId          AS topicId,
                t.entityType        AS entityType,
                t.canonicalName     AS canonicalName,
                sum(m.mentionCount) AS totalMentionCount
         ORDER BY totalMentionCount DESC`,
        { nodeIds, pruned: nodesToPrune }
      );

      const topicRelTypeResult = await session.run(
        `MATCH (c:MemoryNode)-[m:MENTIONS]->(t:TopicNode)
         WHERE c.nodeId IN $nodeIds AND NOT c.nodeId IN $pruned
         WITH t, m.relationshipType AS relType, sum(m.mentionCount) AS relCount
         ORDER BY t.topicId ASC, relCount DESC
         RETURN t.topicId AS topicId,
                collect({ relationshipType: relType, count: relCount })[0..3] AS topRelTypes`,
        { nodeIds, pruned: nodesToPrune }
      );

      const topicRows: CommunityTopicRow[] = topicContextResult.records.map((r) => ({
        topicId: r.get("topicId") as string,
        entityType: r.get("entityType") as string,
        canonicalName: r.get("canonicalName") as string,
        totalMentionCount: normalizeNeo4jNumber(r.get("totalMentionCount")),
      }));

      const relTypeMap = new Map<string, TopicRelTypeRow["topRelTypes"]>();
      for (const r of topicRelTypeResult.records) {
        relTypeMap.set(
          r.get("topicId") as string,
          r.get("topRelTypes") as TopicRelTypeRow["topRelTypes"]
        );
      }

      const semanticEntities: SemanticCommunityEntity[] = topicRows.map((row) => ({
        entityId: row.topicId,
        entityType: row.entityType,
        canonicalName: row.canonicalName,
        mentionCount: row.totalMentionCount,
      }));

      const semanticRelations: SemanticCommunityRelation[] = semanticEntities.flatMap((entity) => {
        const relTypes = relTypeMap.get(entity.entityId) ?? [];
        return relTypes.map((rt) => ({
          relationshipType: rt.relationshipType,
          entityType: entity.entityType,
          canonicalName: entity.canonicalName,
          confidence: Math.min(rt.count / Math.max(entity.mentionCount, 1), 1.0),
          relationshipHint: null,
        }));
      });

      const conceptAnchors = buildConceptAnchors(semanticEntities);
      const distilledFact = await provider.generate(
        buildDistillationPrompt(contents, semanticEntities, semanticRelations, conceptAnchors)
      );

      if (distilledFact) {
        const embedding = await provider.embed(distilledFact);
        await storeFact(distilledFact, embedding, nodeIds, {
          communityId: normalizeNeo4jNumber(communityId),
          communitySize: nodeIds.length,
          semanticEntityCount: semanticEntities.length,
          semanticRelationCount: semanticRelations.length,
          semanticAnchors: semanticEntities
            .slice()
            .sort((left, right) => right.mentionCount - left.mentionCount)
            .slice(0, 12)
            .map(({ canonicalName, entityType, mentionCount }) => ({
              canonicalName,
              entityType,
              mentionCount,
            })),
        });
        consolidatedCount++;
      }

      processedCommunities += 1;
      const progress = interpolateProgress(
        SLEEP_CYCLE_PROGRESS.distillStart,
        SLEEP_CYCLE_PROGRESS.distillComplete,
        processedCommunities,
        eligibleCommunities.length
      );
      await markJobRunning(jobId, "distill_facts", progress);

      const currentPercent = Math.floor((processedCommunities / Math.max(eligibleCommunities.length, 1)) * 100);
      if (processedCommunities === eligibleCommunities.length || processedCommunities === 1 || currentPercent >= lastDistillEventPercent + 20) {
        lastDistillEventPercent = currentPercent;
        await recordPipelineEvent({
          jobId,
          stage: "distill_facts",
          message: `Distilled ${processedCommunities} of ${eligibleCommunities.length} communities into LTM candidates`,
          payload: {
            progress,
            processedCommunities,
            totalCommunities: eligibleCommunities.length,
            consolidated: consolidatedCount,
          },
        });
      }
    }

    if (eligibleCommunities.length > 0) {
      await markJobRunning(jobId, "distill_facts", SLEEP_CYCLE_PROGRESS.distillComplete);
      await recordPipelineEvent({
        jobId,
        stage: "distill_facts",
        message: "Finished consolidating MTM communities into LTM facts",
        payload: {
          progress: SLEEP_CYCLE_PROGRESS.distillComplete,
          totalCommunities: eligibleCommunities.length,
          consolidated: consolidatedCount,
        },
      });
    }

    await markJobRunning(jobId, "cleanup", SLEEP_CYCLE_PROGRESS.cleanup);
    await recordPipelineEvent({
      jobId,
      stage: "cleanup",
      message: "MTM pruning and distillation complete",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.cleanup,
        pruned: nodesToPrune.length,
        consolidated: consolidatedCount,
      },
    });

    // ------------------------------------------------------------------
    // Step 16. Topic Node Pruning
    // ------------------------------------------------------------------
    let topicPruneStats = { deleted: 0 };
    try {
      await markJobRunning(jobId, "topic_prune", SLEEP_CYCLE_PROGRESS.topicPrune);
      topicPruneStats = await pruneStaleTopicNodes({ minMentionCount: 2, maxAgeDays: 30 });
      await recordPipelineEvent({
        jobId,
        stage: "topic_prune",
        message: `Topic pruning: ${topicPruneStats.deleted} stale TopicNodes removed (mentionCount < 2 and not mentioned in 30 days)`,
        payload: { progress: SLEEP_CYCLE_PROGRESS.topicPrune, ...topicPruneStats },
      });
    } catch (topicPruneError) {
      console.error("[consolidationService] Topic pruning failed:", topicPruneError);
      await recordPipelineEvent({
        jobId,
        stage: "topic_prune",
        level: "error",
        message: "Topic pruning failed — sleep cycle will still complete",
        payload: { error: topicPruneError instanceof Error ? topicPruneError.message : String(topicPruneError) },
      });
    }

    // ------------------------------------------------------------------
    // Step 17. STM Pruning
    // ------------------------------------------------------------------
    let stmStats = { deletedByAge: 0, deletedByCount: 0 };
    try {
      await markJobRunning(jobId, "stm_prune", SLEEP_CYCLE_PROGRESS.stmPrune);
      const cfg = getPruningConfig();
      stmStats = await pruneStm({ maxAgeHours: cfg.stmMaxAgeHours, maxRowsPerSession: cfg.stmMaxRowsPerSession });
      await recordPipelineEvent({
        jobId,
        stage: "stm_prune",
        message: `STM pruned: ${stmStats.deletedByAge} entries removed by age, ${stmStats.deletedByCount} removed by session count cap`,
        payload: { progress: SLEEP_CYCLE_PROGRESS.stmPrune, ...stmStats },
      });
    } catch (stmError) {
      console.error("[consolidationService] STM prune failed:", stmError);
      await recordPipelineEvent({
        jobId,
        stage: "stm_prune",
        level: "error",
        message: "STM pruning failed — sleep cycle will still complete",
        payload: { error: stmError instanceof Error ? stmError.message : String(stmError) },
      });
    }

    // ------------------------------------------------------------------
    // Step 18. LTM Condensation
    // ------------------------------------------------------------------
    let ltmStats = { clustersFound: 0, factsCondensed: 0, newFactsCreated: 0 };
    try {
      await markJobRunning(jobId, "ltm_condense", SLEEP_CYCLE_PROGRESS.ltmCondense);
      const ltmCfg = getPruningConfig();
      ltmStats = await condenseLtmFacts({ dormancyDays: ltmCfg.ltmDormancyDays, similarityThreshold: ltmCfg.ltmSimilarityThreshold });
      await recordPipelineEvent({
        jobId,
        stage: "ltm_condense",
        message:
          ltmStats.clustersFound > 0
            ? `LTM condensation: ${ltmStats.factsCondensed} dormant facts merged into ${ltmStats.newFactsCreated} coarser summaries across ${ltmStats.clustersFound} clusters`
            : "LTM condensation: no dormant fact clusters found",
        payload: { progress: SLEEP_CYCLE_PROGRESS.ltmCondense, ...ltmStats },
      });
    } catch (ltmError) {
      console.error("[consolidationService] LTM condensation failed:", ltmError);
      await recordPipelineEvent({
        jobId,
        stage: "ltm_condense",
        level: "error",
        message: "LTM condensation failed — sleep cycle will still complete",
        payload: { error: ltmError instanceof Error ? ltmError.message : String(ltmError) },
      });
    }

    await recordPipelineEvent({
      jobId,
      stage: "cleanup",
      message: "Sleep cycle completed",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.completed,
        pruned: nodesToPrune.length,
        consolidated: consolidatedCount,
        topicNodesDeleted: topicPruneStats.deleted,
        stmDeletedByAge: stmStats.deletedByAge,
        stmDeletedByCount: stmStats.deletedByCount,
        ltmClustersCondensed: ltmStats.clustersFound,
        ltmFactsCondensed: ltmStats.factsCondensed,
      },
    });
    await markJobCompleted(jobId, "completed", 100, {
      pruned: nodesToPrune.length,
      consolidated: consolidatedCount,
    });
  } catch (error) {
    await markJobFailed(jobId, "failed", error instanceof Error ? error.message : String(error));
    await recordPipelineEvent({
      jobId,
      stage: "failed",
      level: "error",
      message: "Sleep cycle failed",
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally {
    if (knnGraphProjected) {
      try { await session.run(`CALL gds.graph.drop($graphName)`, { graphName: knnGraphName }); }
      catch (e) { console.error("Failed to drop KNN graph:", e); }
    }
    if (analyticsGraphProjected) {
      try { await session.run(`CALL gds.graph.drop($graphName)`, { graphName: analyticsGraphName }); }
      catch (e) { console.error("Failed to drop analytics graph:", e); }
    }
    if (louvainGraphProjected) {
      try { await session.run(`CALL gds.graph.drop($graphName)`, { graphName: louvainGraphName }); }
      catch (e) { console.error("Failed to drop Louvain graph:", e); }
    }
    await session.close();
  }
}

function interpolateProgress(start: number, end: number, completedUnits: number, totalUnits: number) {
  if (totalUnits <= 0) {
    return end;
  }

  const ratio = Math.min(1, Math.max(0, completedUnits / totalUnits));
  return Math.round(start + (end - start) * ratio);
}

function buildConceptAnchors(semanticEntities: SemanticCommunityEntity[]): string {
  const conceptCounts = new Map<string, number>();

  for (const entity of semanticEntities) {
    const canonicalKey = entity.entityId.split(":")[1];
    const mapping = CONCEPT_HIERARCHY[canonicalKey];
    if (!mapping) continue;

    const concept = mapping.parent;
    conceptCounts.set(concept, (conceptCounts.get(concept) ?? 0) + entity.mentionCount);
  }

  if (conceptCounts.size === 0) {
    return "- none";
  }

  return Array.from(conceptCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([concept, count]) => `- ${concept} (mentions: ${count})`)
    .join("\n");
}

function buildDistillationPrompt(
  contents: string[],
  semanticEntities: SemanticCommunityEntity[],
  semanticRelations: SemanticCommunityRelation[],
  conceptAnchors: string
) {
  const episodicSection = contents.join("\n");
  const semanticEntitySection = formatSemanticEntities(semanticEntities);
  const semanticRelationSection = formatSemanticRelations(semanticRelations);

  return [
    "Synthesize the following episodic memories into a single, dense, generalized semantic fact.",
    "Strip away specific dates and verbatim quotes. Focus on the underlying truth, preference, or durable state.",
    "Use the semantic anchors and entity relations to resolve recurring people, places, projects, tools, and topics.",
    "Do not invent facts that are not supported by the memories or semantic anchors.",
    "",
    "Episodic memories:",
    episodicSection,
    "",
    "Semantic anchors:",
    semanticEntitySection,
    "",
    "Concept domains:",
    conceptAnchors,
    "",
    "Entity relations:",
    semanticRelationSection,
  ].join("\n");
}

function formatSemanticEntities(semanticEntities: SemanticCommunityEntity[]) {
  if (semanticEntities.length === 0) {
    return "- none";
  }

  return semanticEntities
    .slice()
    .sort((left, right) => {
      if (right.mentionCount !== left.mentionCount) {
        return right.mentionCount - left.mentionCount;
      }

      return left.canonicalName.localeCompare(right.canonicalName);
    })
    .slice(0, 16)
    .map(
      (entity) =>
        `- [${entity.entityType}] ${entity.canonicalName}${entity.mentionCount > 0 ? ` (mentions: ${entity.mentionCount})` : ""
        }`
    )
    .join("\n");
}

function formatSemanticRelations(semanticRelations: SemanticCommunityRelation[]) {
  if (semanticRelations.length === 0) {
    return "- none";
  }

  return semanticRelations
    .slice()
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      return left.relationshipType.localeCompare(right.relationshipType);
    })
    .slice(0, 24)
    .map(
      (relation) =>
        `- ${relation.relationshipType} -> ${relation.canonicalName} [${relation.entityType}]${relation.relationshipHint ? ` | ${relation.relationshipHint}` : ""
        }`
    )
    .join("\n");
}

function normalizeNeo4jNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }

  return Number(value ?? 0);
}