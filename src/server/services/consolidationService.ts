import { getNeo4jDriver } from "../db/neo4j.js";
import { getProvider } from "../providers/index.js";
import { SEMANTIC_RELATIONSHIP_TYPES } from "./entityExtractionService.js";
import { storeFact } from "./ltmService.js";
import { createJob, markJobCompleted, markJobFailed, markJobRunning, recordPipelineEvent } from "./jobService.js";

const SALIENCE_PERCENTILE = 25;
const MIN_COMMUNITY_SIZE = 3;
const SLEEP_CYCLE_NODE_LABELS = ["EpisodicNode", "SemanticNode"];
const SLEEP_CYCLE_RELATIONSHIP_PROJECTION = Object.fromEntries(
  ["SIMILAR_TO", ...SEMANTIC_RELATIONSHIP_TYPES].map((relationshipType) => [
    relationshipType,
    { orientation: "UNDIRECTED", properties: ["weight"] },
  ])
);

interface PageRankScore {
  graphNodeId: string;
  nodeType: string;
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
      `CALL gds.graph.project($graphName, $nodeLabels, $relationshipProjection)`,
      {
        graphName,
        nodeLabels: SLEEP_CYCLE_NODE_LABELS,
        relationshipProjection: SLEEP_CYCLE_RELATIONSHIP_PROJECTION,
      }
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
      RETURN coalesce(gds.util.asNode(nodeId).nodeId, gds.util.asNode(nodeId).entityId) AS graphNodeId,
             coalesce(gds.util.asNode(nodeId).type, '') AS nodeType,
             score
      ORDER BY score ASC`,
      { graphName }
    );

    const scores: PageRankScore[] = prResult.records.map((r) => ({
      graphNodeId: String(r.get("graphNodeId") ?? ""),
      nodeType: String(r.get("nodeType") ?? ""),
      score: Number(r.get("score") ?? 0),
    }));
    const episodicScores = scores.filter(
      (score) => score.nodeType === "episodic" && score.graphNodeId.length > 0
    );
    const semanticScoreCount = scores.filter((score) => score.nodeType === "semantic").length;

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
    const sorted = episodicScores.map((s) => s.score).sort((a, b) => a - b);
    const thresholdIdx = Math.floor(
      (SALIENCE_PERCENTILE / 100) * sorted.length
    );
    const threshold = sorted[thresholdIdx] ?? 0;
    const nodesToPrune = episodicScores
      .filter((s) => s.score < threshold)
      .map((s) => s.graphNodeId);
    await recordPipelineEvent({
      jobId,
      stage: "rank_nodes",
      message: "Calculated PageRank scores",
      payload: {
        nodeCount,
        episodicNodeCount: episodicScores.length,
        semanticNodeCount: semanticScoreCount,
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
      const communityId = record.get("cid");
      const nodeIds = record.get("nodeIds") as string[];
      const contents = record.get("contents") as string[];

      if (nodeIds.length < MIN_COMMUNITY_SIZE) continue;

      const semanticContextResult = await session.run(
        `MATCH (e:EpisodicNode)-[r]->(s:SemanticNode)
         WHERE e.communityId = $communityId AND NOT e.nodeId IN $pruned
         RETURN collect(DISTINCT {
                  entityId: s.entityId,
                  entityType: s.entityType,
                  canonicalName: s.canonicalName,
                  mentionCount: coalesce(s.mentionCount, 0)
                }) AS semanticEntities,
                collect(DISTINCT {
                  relationshipType: type(r),
                  entityType: s.entityType,
                  canonicalName: s.canonicalName,
                  confidence: coalesce(r.confidence, 0.0),
                  relationshipHint: r.relationshipHint
                }) AS semanticRelations`,
        { communityId, pruned: nodesToPrune }
      );
      const semanticContext = semanticContextResult.records[0];
      const semanticEntities = ((semanticContext?.get("semanticEntities") as SemanticCommunityEntity[] | null) ?? [])
        .filter((entity): entity is SemanticCommunityEntity => Boolean(entity?.entityId && entity?.canonicalName));
      const semanticRelations = ((semanticContext?.get("semanticRelations") as SemanticCommunityRelation[] | null) ?? [])
        .filter((relation): relation is SemanticCommunityRelation => Boolean(relation?.relationshipType && relation?.canonicalName));

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
    await session.run(
      `MATCH (s:SemanticNode)
       WHERE NOT (:EpisodicNode)--(s)
       DETACH DELETE s`
    );
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
