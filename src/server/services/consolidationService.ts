import { getNeo4jDriver } from "../db/neo4j.js";
import { getProvider } from "../providers/index.js";
import { storeFact } from "./ltmService.js";
import { createJob, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";
import { parseStoredSemanticEntities, type StoredSemanticEntity } from "./semanticGraphAttributes.js";

const SALIENCE_PERCENTILE = 25;
const MIN_COMMUNITY_SIZE = 3;
const SLEEP_CYCLE_NODE_LABELS = ["EpisodicNode"];
const SLEEP_CYCLE_RELATIONSHIP_PROJECTION = {
  SIMILAR_TO: { orientation: "UNDIRECTED", properties: ["combinedWeight"] },
};

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

    await session.run(
      `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
      {
        graphName,
        nodeLabels: SLEEP_CYCLE_NODE_LABELS,
        relationshipProjection: SLEEP_CYCLE_RELATIONSHIP_PROJECTION,
      }
    );
    await markJobRunning(jobId, "rank_nodes", SLEEP_CYCLE_PROGRESS.rankNodesStart);
    await recordPipelineEvent({
      jobId,
      stage: "project_graph",
      message: "Projected the MTM graph for sleep-cycle analytics",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.rankNodesStart,
        nodeCount,
      },
    });

    // ------------------------------------------------------------------
    // 2. PageRank (Synaptic Pruning)
    // ------------------------------------------------------------------
    const prResult = await session.run(
      `CALL gds.pageRank.stream($graphName, {
        relationshipWeightProperty: 'combinedWeight',
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
        relationshipWeightProperty: 'combinedWeight',
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
    // 3. Louvain Community Detection
    // ------------------------------------------------------------------
    await session.run(
      `CALL gds.louvain.write($graphName, {
        relationshipWeightProperty: 'combinedWeight',
        writeProperty: 'communityId'
      })`,
      { graphName }
    );
    await markJobRunning(jobId, "cluster_communities", SLEEP_CYCLE_PROGRESS.clusterCommunities);

    // Read communities (excluding pruned nodes)
    const commResult = await session.run(
      `MATCH (n:EpisodicNode)
       WHERE n.communityId IS NOT NULL AND NOT n.nodeId IN $pruned
       RETURN n.communityId AS cid, collect(n.nodeId) AS nodeIds, collect(n.content) AS contents`,
      { pruned: nodesToPrune }
    );
    const eligibleCommunities = commResult.records.filter(
      (record) => ((record.get("nodeIds") as string[]) ?? []).length >= MIN_COMMUNITY_SIZE
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
      const communityId = record.get("cid");
      const nodeIds = record.get("nodeIds") as string[];
      const contents = record.get("contents") as string[];

      const semanticContextResult = await session.run(
        `MATCH (e:EpisodicNode)
         WHERE e.communityId = $communityId AND NOT e.nodeId IN $pruned
         RETURN collect(coalesce(e.semanticPayloadJson, '[]')) AS semanticPayloads`,
        { communityId, pruned: nodesToPrune }
      );
      const semanticContext = semanticContextResult.records[0];
      const semanticPayloads =
        ((semanticContext?.get("semanticPayloads") as string[] | null) ?? []).map((payload) =>
          parseStoredSemanticEntities(payload)
        );
      const { semanticEntities, semanticRelations } = buildCommunitySemanticContext(
        semanticPayloads.flat()
      );

      const distilledFact = await provider.generate(
        buildDistillationPrompt(contents, semanticEntities, semanticRelations)
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

    // ------------------------------------------------------------------
    // 5. Execute Synaptic Pruning
    // ------------------------------------------------------------------
    if (nodesToPrune.length > 0) {
      await session.run(
        `MATCH (n:EpisodicNode) WHERE n.nodeId IN $ids DETACH DELETE n`,
        { ids: nodesToPrune }
      );
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

    await recordPipelineEvent({
      jobId,
      stage: "cleanup",
      message: "Sleep cycle completed",
      payload: {
        progress: SLEEP_CYCLE_PROGRESS.completed,
        pruned: nodesToPrune.length,
        consolidated: consolidatedCount,
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

function buildDistillationPrompt(
  contents: string[],
  semanticEntities: SemanticCommunityEntity[],
  semanticRelations: SemanticCommunityRelation[]
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
        `- [${entity.entityType}] ${entity.canonicalName}${
          entity.mentionCount > 0 ? ` (mentions: ${entity.mentionCount})` : ""
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
        `- ${relation.relationshipType} -> ${relation.canonicalName} [${relation.entityType}]${
          relation.relationshipHint ? ` | ${relation.relationshipHint}` : ""
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
