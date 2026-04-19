import { type Session } from "neo4j-driver";

import { getNeo4jDriver } from "../db/neo4j.js";
import { getProvider } from "../providers/index.js";
import { storeFact, condenseLtmFacts } from "./ltmService.js";
import { pruneStm } from "./stmService.js";
import { createJob, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";
import { parseStoredSemanticEntities, type StoredSemanticEntity } from "./semanticGraphAttributes.js";
import { CONCEPT_HIERARCHY } from "../ontology/conceptHierarchy.js";
import { getPruningConfig } from "../config/pruningConfig.js";

const SALIENCE_PERCENTILE = 25;
const MIN_COMMUNITY_SIZE = 2;
const MENTIONS_COVERAGE_THRESHOLD = 0.15;
const SLEEP_CYCLE_NODE_LABELS = ["EpisodicNode"];
const SLEEP_CYCLE_RELATIONSHIP_PROJECTION = {
  SIMILAR_TO: { orientation: "UNDIRECTED", properties: ["combinedWeight"] },
};

// Cypher projection relationship query for bipartite (topic-Jaccard) graph.
// Part 1: chunk pairs connected via shared TopicNodes, weighted by Jaccard similarity.
// Part 2: fallback SIMILAR_TO edges for chunks with no MENTIONS coverage.
// id(c1) < id(c2) deduplicates pairs; GDS reads the returned `weight` column automatically.
const BIPARTITE_RELATIONSHIP_QUERY = `
MATCH (c1:EpisodicNode)-[:MENTIONS]->(t:TopicNode)<-[:MENTIONS]-(c2:EpisodicNode)
WHERE id(c1) < id(c2)
WITH c1, c2, count(DISTINCT t) AS intersection
WHERE intersection > 0
MATCH (c1)-[:MENTIONS]->(allT1:TopicNode)
WITH c1, c2, intersection, count(DISTINCT allT1) AS c1Topics
MATCH (c2)-[:MENTIONS]->(allT2:TopicNode)
WITH c1, c2, intersection, c1Topics, count(DISTINCT allT2) AS c2Topics
WHERE (c1Topics + c2Topics - intersection) > 0
RETURN id(c1) AS source,
       id(c2) AS target,
       toFloat(intersection) / (c1Topics + c2Topics - intersection) AS weight

UNION ALL

MATCH (c1:EpisodicNode)-[r:SIMILAR_TO]-(c2:EpisodicNode)
WHERE id(c1) < id(c2)
  AND NOT (c1)-[:MENTIONS]->(:TopicNode)<-[:MENTIONS]-(c2)
RETURN id(c1) AS source,
       id(c2) AS target,
       coalesce(r.combinedWeight, r.weight, 0.75) AS weight
`;

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
  entityKeys: string[];
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

async function checkMentionsCoverage(
  session: Session
): Promise<{ totalNodes: number; coverage: number }> {
  const result = await session.run(
    `MATCH (n:EpisodicNode)
     WITH count(n) AS totalNodes
     MATCH (n2:EpisodicNode)-[:MENTIONS]->(:TopicNode)
     WITH totalNodes, count(DISTINCT n2) AS nodesWithMentions
     RETURN totalNodes, toFloat(nodesWithMentions) / totalNodes AS coverage`
  );
  const record = result.records[0];
  if (!record) return { totalNodes: 0, coverage: 0 };
  const totalNodes = normalizeNeo4jNumber(record.get("totalNodes"));
  const coverage = Number(record.get("coverage") ?? 0);
  return { totalNodes, coverage };
}

export interface SleepCycleLaunchResult {
  jobId: string;
  status: "queued";
  stage: "project_graph";
  progress: 0;
}

const SLEEP_CYCLE_PROGRESS = {
  projectGraphStart: 8,
  rankNodesStart: 24,
  rankNodesComplete: 42,
  clusterCommunities: 55,
  distillStart: 62,
  distillComplete: 92,
  cleanup: 97,
  stmPrune: 98,
  ltmCondense: 99,
  completed: 100,
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

  try {
    await markJobRunning(jobId, "project_graph", SLEEP_CYCLE_PROGRESS.projectGraphStart);
    await recordPipelineEvent({
      jobId,
      stage: "project_graph",
      message: "Sleep cycle started",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.projectGraphStart,
      },
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
        payload: {
          progress: SLEEP_CYCLE_PROGRESS.completed,
          pruned: 0,
          consolidated: 0,
        },
      });
      return;
    }

    // ------------------------------------------------------------------
    // 1. Project the in-memory graph for GDS algorithms
    // ------------------------------------------------------------------
    const graphName = `nhrag_sleep_${Date.now()}`;

    // Check MENTIONS coverage to decide which projection strategy to use.
    // If >= 15% of EpisodicNodes have MENTIONS edges, use the bipartite Cypher
    // projection (Jaccard topic-overlap weights). Otherwise fall back to the
    // native SIMILAR_TO projection so isolated/unbackfilled nodes are not
    // penalised during early rollout.
    const { coverage: mentionsCoverage } = await checkMentionsCoverage(session);
    const usesBipartiteProjection = mentionsCoverage >= MENTIONS_COVERAGE_THRESHOLD;
    const weightProperty = usesBipartiteProjection ? "weight" : "combinedWeight";

    if (usesBipartiteProjection) {
      await session.run(
        `CALL gds.graph.project($graphName, $nodeQuery, $relationshipQuery)`,
        {
          graphName,
          nodeQuery: "MATCH (n:EpisodicNode) RETURN id(n) AS id",
          relationshipQuery: BIPARTITE_RELATIONSHIP_QUERY,
        }
      );
    } else {
      await session.run(
        `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
        {
          graphName,
          nodeLabels: SLEEP_CYCLE_NODE_LABELS,
          relationshipProjection: SLEEP_CYCLE_RELATIONSHIP_PROJECTION,
        }
      );
    }

    await markJobRunning(jobId, "rank_nodes", SLEEP_CYCLE_PROGRESS.rankNodesStart);
    await recordPipelineEvent({
      jobId,
      stage: "project_graph",
      message: `Projected the MTM graph for sleep-cycle analytics (${usesBipartiteProjection ? `bipartite/topic-Jaccard, coverage=${(mentionsCoverage * 100).toFixed(1)}%` : "native/SIMILAR_TO fallback"})`,
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.rankNodesStart,
        nodeCount,
        mentionsCoverage,
        usesBipartiteProjection,
      },
    });

    // ------------------------------------------------------------------
    // 2. PageRank (Synaptic Pruning)
    // ------------------------------------------------------------------
    const prResult = await session.run(
      `CALL gds.pageRank.stream($graphName, {
        relationshipWeightProperty: '${weightProperty}',
        dampingFactor: 0.85
      })
      YIELD nodeId, score
      RETURN gds.util.asNode(nodeId).nodeId AS graphNodeId,
             score
      ORDER BY score ASC`,
      { graphName }
    );

    const scores: PageRankScore[] = prResult.records.map((r) => ({
      graphNodeId: String(r.get("graphNodeId") ?? ""),
      score: Number(r.get("score") ?? 0),
    }));
    const episodicScores = scores.filter((score) => score.graphNodeId.length > 0);

    // Write PageRank back to nodes for reference
    await session.run(
      `CALL gds.pageRank.write($graphName, {
        relationshipWeightProperty: '${weightProperty}',
        dampingFactor: 0.85,
        writeProperty: 'pageRank'
      })`,
      { graphName }
    );

    // Calculate pruning threshold (bottom 25th percentile)
    const sorted = episodicScores.map((s) => s.score).sort((a, b) => a - b);
    const thresholdIdx = Math.floor(
      (SALIENCE_PERCENTILE / 100) * sorted.length
    );
    const threshold = sorted[thresholdIdx] ?? 0;
    const nodesToPrune = episodicScores
      .filter((s) => s.score < threshold)
      .map((s) => s.graphNodeId);
    await markJobRunning(jobId, "rank_nodes", SLEEP_CYCLE_PROGRESS.rankNodesComplete);
    await recordPipelineEvent({
      jobId,
      stage: "rank_nodes",
      message: "Calculated PageRank scores",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.rankNodesComplete,
        nodeCount,
        episodicNodeCount: episodicScores.length,
        threshold,
        nodesToPrune: nodesToPrune.length,
      },
    });

    // ------------------------------------------------------------------
    // 3. Community Detection (Leiden with Louvain fallback)
    // ------------------------------------------------------------------
    try {
      await session.run(
        `CALL gds.leiden.write($graphName, {
          relationshipWeightProperty: '${weightProperty}',
          writeProperty: 'communityId',
          gamma: 1.0,
          theta: 0.01
        })`,
        { graphName }
      );
    } catch (error) {
      console.warn("gds.leiden not available, falling back to gds.louvain:", error);
      await session.run(
        `CALL gds.louvain.write($graphName, {
          relationshipWeightProperty: '${weightProperty}',
          writeProperty: 'communityId',
          tolerance: 0.0001,
          maxIterations: 20
        })`,
        { graphName }
      );
    }
    await markJobRunning(jobId, "cluster_communities", SLEEP_CYCLE_PROGRESS.clusterCommunities);

    // Read communities (excluding pruned nodes), including flattened entity keys
    const commResult = await session.run(
      `MATCH (n:EpisodicNode)
       WHERE n.communityId IS NOT NULL AND NOT n.nodeId IN $pruned
       WITH n
       OPTIONAL MATCH (n)-[:MENTIONS]->(t:TopicNode)
       RETURN n.communityId                AS cid,
              collect(DISTINCT n.nodeId)   AS nodeIds,
              collect(DISTINCT n.content)  AS contents,
              collect(DISTINCT t.topicId)  AS topicKeys`,
      { pruned: nodesToPrune }
    );

    // Parse raw records, merge bridged communities, then filter by minimum size
    const communityRecords: CommunityRecord[] = commResult.records.map((record) => ({
      cid: record.get("cid"),
      nodeIds: record.get("nodeIds") as string[],
      contents: record.get("contents") as string[],
      entityKeys: (record.get("topicKeys") as Array<string | null>).filter((k): k is string => k !== null),
    }));
    // Topic sets are smaller than old entity key arrays — lower threshold to 2
    const mergedCommunityRecords = mergeBridgedCommunities(communityRecords, 2);
    const eligibleCommunities = mergedCommunityRecords.filter(
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
    // 4. Distill surviving communities to LTM
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

      // Fetch topic context from the bipartite graph (primary source)
      const topicContextResult = await session.run(
        `MATCH (c:EpisodicNode)-[m:MENTIONS]->(t:TopicNode)
         WHERE c.nodeId IN $nodeIds AND NOT c.nodeId IN $pruned
         RETURN t.topicId          AS topicId,
                t.entityType        AS entityType,
                t.canonicalName     AS canonicalName,
                sum(m.mentionCount) AS totalMentionCount
         ORDER BY totalMentionCount DESC`,
        { nodeIds, pruned: nodesToPrune }
      );

      const topicRelTypeResult = await session.run(
        `MATCH (c:EpisodicNode)-[m:MENTIONS]->(t:TopicNode)
         WHERE c.nodeId IN $nodeIds AND NOT c.nodeId IN $pruned
         WITH t, m.relationshipType AS relType, sum(m.mentionCount) AS relCount
         ORDER BY t.topicId ASC, relCount DESC
         RETURN t.topicId AS topicId,
                collect({ relationshipType: relType, count: relCount })[0..3] AS topRelTypes`,
        { nodeIds, pruned: nodesToPrune }
      );

      // Fallback: legacy semanticPayloadJson for nodes not yet backfilled with MENTIONS edges
      const legacyResult = await session.run(
        `MATCH (c:EpisodicNode)
         WHERE c.nodeId IN $nodeIds AND NOT c.nodeId IN $pruned
           AND NOT (c)-[:MENTIONS]->(:TopicNode)
         RETURN collect(coalesce(c.semanticPayloadJson, '[]')) AS legacyPayloads`,
        { nodeIds, pruned: nodesToPrune }
      );

      // Build SemanticCommunityEntity list from TopicNode graph rows
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

      const bipartiteEntities: SemanticCommunityEntity[] = topicRows.map((row) => ({
        entityId: row.topicId,
        entityType: row.entityType,
        canonicalName: row.canonicalName,
        mentionCount: row.totalMentionCount,
      }));

      const bipartiteRelations: SemanticCommunityRelation[] = bipartiteEntities.flatMap((entity) => {
        const relTypes = relTypeMap.get(entity.entityId) ?? [];
        return relTypes.map((rt) => ({
          relationshipType: rt.relationshipType,
          entityType: entity.entityType,
          canonicalName: entity.canonicalName,
          confidence: Math.min(rt.count / Math.max(entity.mentionCount, 1), 1.0),
          relationshipHint: null,
        }));
      });

      // Merge legacy fallback for unbackfilled nodes
      const legacyPayloads = (legacyResult.records[0]?.get("legacyPayloads") as string[] | null) ?? [];
      const legacySemanticContext = buildCommunitySemanticContext(
        legacyPayloads.flatMap((p) => parseStoredSemanticEntities(p))
      );

      const entityIdsSeen = new Set(bipartiteEntities.map((e) => e.entityId));
      const mergedEntities: SemanticCommunityEntity[] = [
        ...bipartiteEntities,
        ...legacySemanticContext.semanticEntities.filter((e) => !entityIdsSeen.has(e.entityId)),
      ];
      const mergedRelations: SemanticCommunityRelation[] = [
        ...bipartiteRelations,
        ...legacySemanticContext.semanticRelations,
      ];

      const conceptAnchors = buildConceptAnchors(mergedEntities);
      const distilledFact = await provider.generate(
        buildDistillationPrompt(contents, mergedEntities, mergedRelations, conceptAnchors)
      );

      if (distilledFact) {
        const embedding = await provider.embed(distilledFact);
        await storeFact(distilledFact, embedding, nodeIds, {
          communityId: normalizeNeo4jNumber(communityId),
          communitySize: nodeIds.length,
          semanticEntityCount: mergedEntities.length,
          semanticRelationCount: mergedRelations.length,
          semanticAnchors: mergedEntities
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

    // ------------------------------------------------------------------
    // 5. Execute Synaptic Pruning
    // ------------------------------------------------------------------
    if (nodesToPrune.length > 0) {
      await session.run(
        `MATCH (n:EpisodicNode) WHERE n.nodeId IN $ids DETACH DELETE n`,
        { ids: nodesToPrune }
      );

      // Clean up TopicNodes that are no longer referenced by any EpisodicNode.
      // Non-fatal — orphaned topics have no impact on GDS projections but waste storage.
      if (nodesToPrune.length > 10) {
        try {
          await session.run(
            `MATCH (t:TopicNode)
             WHERE NOT (t)<-[:MENTIONS]-(:EpisodicNode)
             DETACH DELETE t`
          );
        } catch (orphanError) {
          console.warn("[consolidationService] Orphaned TopicNode cleanup failed (non-fatal):", orphanError);
        }
      }
    }
    await markJobRunning(jobId, "cleanup", SLEEP_CYCLE_PROGRESS.cleanup);
    await recordPipelineEvent({
      jobId,
      stage: "cleanup",
      message: "Pruned low-salience MTM nodes and finalized graph cleanup",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.cleanup,
        pruned: nodesToPrune.length,
        consolidated: consolidatedCount,
      },
    });

    // ------------------------------------------------------------------
    // 6. Drop the projected graph
    // ------------------------------------------------------------------
    await session.run(`CALL gds.graph.drop($graphName)`, { graphName });

    // ------------------------------------------------------------------
    // 7. STM Pruning — remove aged-out conversation entries and enforce per-session row caps
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
        payload: {
          progress: SLEEP_CYCLE_PROGRESS.stmPrune,
          ...stmStats,
        },
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
    // 8. LTM Condensation — merge similar dormant facts into coarser summaries
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
        payload: {
          progress: SLEEP_CYCLE_PROGRESS.ltmCondense,
          ...ltmStats,
        },
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
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
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

function buildCommunitySemanticContext(entities: StoredSemanticEntity[]) {
  const mergedEntities = new Map<string, SemanticCommunityEntity>();
  const mergedRelations = new Map<string, SemanticCommunityRelation>();

  for (const entity of entities) {
    const entityKey = entity.entityId;
    const relationKey = `${entity.relationshipType}:${entity.entityId}`;
    const existingEntity = mergedEntities.get(entityKey);
    const nextMentionCount = (existingEntity?.mentionCount ?? 0) + Math.max(entity.mentionCount, 1);

    mergedEntities.set(entityKey, {
      entityId: entity.entityId,
      entityType: entity.entityType,
      canonicalName:
        existingEntity && existingEntity.canonicalName.length > entity.canonicalName.length
          ? existingEntity.canonicalName
          : entity.canonicalName,
      mentionCount: nextMentionCount,
    });

    const existingRelation = mergedRelations.get(relationKey);
    mergedRelations.set(relationKey, {
      relationshipType: entity.relationshipType,
      entityType: entity.entityType,
      canonicalName:
        existingRelation && existingRelation.canonicalName.length > entity.canonicalName.length
          ? existingRelation.canonicalName
          : entity.canonicalName,
      confidence: Math.max(existingRelation?.confidence ?? 0, entity.confidence),
      relationshipHint: existingRelation?.relationshipHint ?? entity.relationshipHint,
    });
  }

  return {
    semanticEntities: Array.from(mergedEntities.values()),
    semanticRelations: Array.from(mergedRelations.values()),
  };
}

function mergeBridgedCommunities(
  records: CommunityRecord[],
  minSharedKeys: number = 3
): CommunityRecord[] {
  const n = records.length;

  // Union-Find with path compression
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    if (parent[x] !== x) {
      parent[x] = find(parent[x]);
    }
    return parent[x];
  }

  function union(x: number, y: number): void {
    parent[find(x)] = find(y);
  }

  // Pre-build Sets for O(1) membership checks during pair comparisons
  const keySets = records.map((r) => new Set(r.entityKeys));

  // Check all pairs; union those with >= minSharedKeys overlap
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sharedCount = 0;
      for (const key of keySets[i]) {
        if (keySets[j].has(key)) {
          sharedCount++;
          if (sharedCount >= minSharedKeys) break;
        }
      }
      if (sharedCount >= minSharedKeys) {
        union(i, j);
      }
    }
  }

  // Group records by their root representative
  const groups = new Map<number, CommunityRecord[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(records[i]);
    groups.set(root, group);
  }

  // Merge each group into a single CommunityRecord; singletons pass through unchanged
  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];
    return {
      cid: group[0].cid,
      nodeIds: group.flatMap((r) => r.nodeIds),
      contents: group.flatMap((r) => r.contents),
      entityKeys: Array.from(new Set(group.flatMap((r) => r.entityKeys))),
    };
  });
}
