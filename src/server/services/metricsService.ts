import { getDocumentStats } from "./documentService.js";
import { listJobs, listPipelineEvents } from "./jobService.js";
import { getLtmCount } from "./ltmService.js";
import { getGraphStats, getMtmCount } from "./mtmService.js";
import { getStmCount } from "./stmService.js";

export async function getOverviewMetrics() {
  const [documentStats, stmCount, mtmCount, ltmCount, jobs, events, graph] = await Promise.all([
    getDocumentStats(),
    getStmCount(),
    getMtmCount(),
    getLtmCount(),
    listJobs(12),
    listPipelineEvents({ limit: 12 }),
    getGraphStats(),
  ]);

  return {
    cards: {
      documents: documentStats.totalDocuments,
      chunks: documentStats.totalChunks,
      stm: stmCount,
      mtm: mtmCount,
      ltm: ltmCount,
    },
    storage: {
      totalBytes: documentStats.totalBytes,
      jobsByStatus: documentStats.jobsByStatus,
    },
    recentJobs: jobs,
    recentEvents: events,
    graph,
  };
}