// NH-RAG frontend API client

export type EpisodicActor = "user" | "agent" | "system" | "document";

export interface EpisodicMemory {
  interactionId?: string;
  sessionId: string;
  timestamp: string;
  actor: EpisodicActor;
  rawText: string;
  sourceType?: string;
  documentId?: string | null;
  chunkId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingSummary {
  dimensions: number;
  checksum: string;
}

export interface SemanticFact {
  knowledgeId: string;
  distilledFact: string;
  embedding: number[];
  embeddingSummary: EmbeddingSummary;
  lastAccessed: string;
  provenance?: string[];
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface DocumentRecord {
  documentId: string;
  filename: string;
  mimeType: string;
  checksum: string;
  fileSizeBytes: number;
  parserName: string;
  importStatus: string;
  summary: string | null;
  pageCount: number | null;
  chunkCount: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  statusSummary: DocumentImportStatusSummary;
}

export interface DocumentImportStatusSummary {
  jobId: string | null;
  status: string;
  stage: string;
  progress: number;
  errorMessage: string | null;
  latestEventMessage: string | null;
  latestEventStage: string | null;
  latestEventLevel: string | null;
  latestEventAt: string | null;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentRecord {
  chunks: Array<{
    chunkId: string;
    chunkIndex: number;
    sectionLabel: string | null;
    pageRange: string | null;
    contentText: string;
    tokenEstimate: number;
    metadata: Record<string, unknown>;
  }>;
  events: PipelineEvent[];
}

export interface JobRecord {
  jobId: string;
  documentId: string | null;
  jobType: string;
  status: string;
  stage: string;
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SleepCycleLaunchResult {
  jobId: string;
  status: "queued";
  stage: "project_graph";
  progress: 0;
}

export interface PipelineEvent {
  eventId: string;
  jobId: string | null;
  documentId: string | null;
  stage: string;
  level: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GraphSemanticEntity {
  entityId: string;
  entityType: "person" | "location" | "project" | "tool" | "topic";
  canonicalName: string;
  aliases: string[];
  relationshipType:
  | "MENTIONS_PERSON"
  | "MENTIONS_LOCATION"
  | "LOCATED_IN"
  | "REFERENCES_PROJECT"
  | "WORKS_ON_PROJECT"
  | "USES_TOOL"
  | "MENTIONS_TOOL"
  | "HAS_TOPIC"
  | "MENTIONS_TOPIC"
  | "RELATED_TO_ENTITY";
  relationshipHint: string | null;
  confidence: number;
  mentionCount: number;
}

export interface GraphSharedSemanticEntity {
  entityId: string;
  entityType: "person" | "location" | "project" | "tool" | "topic";
  canonicalName: string;
  confidence: number;
  relationshipTypes: GraphSemanticEntity["relationshipType"][];
  relationshipHints: string[];
}

export interface TopicNodeRecord {
  topicId: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  mentionCount: number;
  confidence: number;
  lastMentionedAt: string | null;
}

export interface MentionsEdge {
  chunkId: string;
  topicId: string;
  confidence: number;
  mentionCount: number;
  relationshipType: string;
}

export interface GraphSnapshot {
  nodes: Array<{
    nodeId: string;
    memoryType: "document" | "chat";
    content: string;
    displayLabel: string;
    consolidatedAt: string;
    pageRank?: number;
    communityId?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    weight: number;
    type: "SIMILARITY";
    updatedAt?: string;
  }>;
  topicNodes: TopicNodeRecord[];
  mentionEdges: MentionsEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    documentNodeCount: number;
    chatNodeCount: number;
    similarityEdgeCount: number;
    topicNodeCount: number;
    mentionEdgeCount: number;
  };
}

export interface OverviewMetrics {
  cards: {
    documents: number;
    chunks: number;
    stm: number;
    mtm: number;
    ltm: number;
  };
  storage: {
    totalBytes: number;
    jobsByStatus: Record<string, number>;
  };
  recentJobs: JobRecord[];
  recentEvents: PipelineEvent[];
  graph: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    documentNodeCount?: number;
    chatNodeCount?: number;
    similarityEdgeCount?: number;
    topicNodeCount?: number;
    mentionEdgeCount?: number;
  };
}

export type QueryEngine = "sql" | "cypher";

export interface PruningConfig {
  stmMaxAgeHours: number;
  stmMaxRowsPerSession: number;
  ltmDormancyDays: number;
  ltmSimilarityThreshold: number;
}

export interface QueryInspectionResult {
  engine: QueryEngine;
  mode: "inspect";
  query: string;
  normalizedQuery: string;
  statementType: string;
  isReadOnly: boolean;
  isDestructive: boolean;
  warnings: string[];
  targets: string[];
  timeoutMs: number;
  maxRows: number;
}

export interface QueryExecutionResult extends Omit<QueryInspectionResult, "mode"> {
  mode: "execute";
  rowCount: number;
  executionTimeMs: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  summary: string;
  counters?: Record<string, number>;
}

export interface ClearKnowledgeBasesResult {
  message: string;
  clearedAt: string;
  sqlQuery: string;
  cypherQuery: string;
  sqlResult: QueryExecutionResult;
  cypherResult: QueryExecutionResult;
}

const API = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export class MemoryService {
  static async inspectSqlQuery(query: string, options?: { timeoutMs?: number; maxRows?: number }): Promise<QueryInspectionResult> {
    const res = await fetch(`${API}/query/sql/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...options }),
    });
    return json<QueryInspectionResult>(res);
  }

  static async executeSqlQuery(query: string, options?: { timeoutMs?: number; maxRows?: number }): Promise<QueryExecutionResult> {
    const res = await fetch(`${API}/query/sql/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...options }),
    });
    return json<QueryExecutionResult>(res);
  }

  static async inspectCypherQuery(query: string, options?: { timeoutMs?: number; maxRows?: number }): Promise<QueryInspectionResult> {
    const res = await fetch(`${API}/query/cypher/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...options }),
    });
    return json<QueryInspectionResult>(res);
  }

  static async executeCypherQuery(query: string, options?: { timeoutMs?: number; maxRows?: number }): Promise<QueryExecutionResult> {
    const res = await fetch(`${API}/query/cypher/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...options }),
    });
    return json<QueryExecutionResult>(res);
  }

  static async clearAllKnowledgeBases(confirmation: string): Promise<ClearKnowledgeBasesResult> {
    const res = await fetch(`${API}/query/clear-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    return json<ClearKnowledgeBasesResult>(res);
  }

  static async listDocuments(): Promise<DocumentRecord[]> {
    const res = await fetch(`${API}/documents`);
    return json<DocumentRecord[]>(res);
  }

  static async importDocuments(files: File[]): Promise<{ documents: DocumentRecord[] }> {
    const form = new FormData();
    files.forEach((file) => form.append("files", file));

    const res = await fetch(`${API}/documents/import`, {
      method: "POST",
      body: form,
    });
    return json<{ documents: DocumentRecord[] }>(res);
  }

  static async getDocumentDetail(documentId: string): Promise<DocumentDetail> {
    const res = await fetch(`${API}/documents/${encodeURIComponent(documentId)}`);
    return json<DocumentDetail>(res);
  }

  static async listStmEntries(options?: {
    page?: number;
    pageSize?: number;
    actor?: EpisodicActor;
    documentId?: string;
    query?: string;
  }): Promise<{ entries: EpisodicMemory[]; total: number }> {
    const params = new URLSearchParams();
    if (options?.page) params.set("page", String(options.page));
    if (options?.pageSize) params.set("pageSize", String(options.pageSize));
    if (options?.actor) params.set("actor", options.actor);
    if (options?.documentId) params.set("documentId", options.documentId);
    if (options?.query) params.set("q", options.query);

    const res = await fetch(`${API}/stm/entries?${params.toString()}`);
    return json<{ entries: EpisodicMemory[]; total: number }>(res);
  }

  static async getGraph(limitCount?: number): Promise<GraphSnapshot> {
    const res = await fetch(
      limitCount === undefined ? `${API}/mtm/graph` : `${API}/mtm/graph?limit=${limitCount}`
    );
    return json<GraphSnapshot>(res);
  }

  // Sleep-Cycle
  static async runSleepCycle(): Promise<SleepCycleLaunchResult> {
    const res = await fetch(`${API}/consolidation/sleep-cycle`, {
      method: "POST",
    });
    return json<SleepCycleLaunchResult>(res);
  }

  static async listLtmFacts(page: number = 1, pageSize: number = 20): Promise<{ facts: SemanticFact[]; total: number }> {
    const res = await fetch(`${API}/ltm/facts?page=${page}&pageSize=${pageSize}`);
    return json<{ facts: SemanticFact[]; total: number }>(res);
  }

  static async listJobs(limitCount: number = 50): Promise<JobRecord[]> {
    const res = await fetch(`${API}/jobs?limit=${limitCount}`);
    return json<JobRecord[]>(res);
  }

  static async listPipelineEvents(options?: { jobId?: string; documentId?: string; limit?: number }): Promise<PipelineEvent[]> {
    const params = new URLSearchParams();
    if (options?.jobId) params.set("jobId", options.jobId);
    if (options?.documentId) params.set("documentId", options.documentId);
    if (options?.limit) params.set("limit", String(options.limit));

    const res = await fetch(`${API}/jobs/events?${params.toString()}`);
    return json<PipelineEvent[]>(res);
  }

  static async getOverviewMetrics(): Promise<OverviewMetrics> {
    const res = await fetch(`${API}/metrics/overview`);
    return json<OverviewMetrics>(res);
  }

  // Health / Stats
  static async testConnection(): Promise<{ status: string; services: Record<string, string> }> {
    const res = await fetch(`${API}/health`);
    return json<{ status: string; services: Record<string, string> }>(res);
  }

  static async getPruningConfig(): Promise<PruningConfig> {
    const res = await fetch(`${API}/pruning`);
    return json<PruningConfig>(res);
  }

  static async updatePruningConfig(updates: Partial<PruningConfig>): Promise<PruningConfig> {
    const res = await fetch(`${API}/pruning`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    return json<PruningConfig>(res);
  }
}
