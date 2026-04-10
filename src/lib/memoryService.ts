// NH-RAG Frontend Memory Service — HTTP client for Express API

export enum Actor {
  USER = "user",
  AGENT = "agent",
  SYSTEM = "system",
  DOCUMENT = "document",
}

export interface EpisodicMemory {
  interactionId?: string;
  sessionId: string;
  timestamp: string;
  actor: Actor;
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

export interface GraphSnapshot {
  nodes: Array<{
    nodeId: string;
    type: "episodic" | "semantic";
    content: string;
    displayLabel: string;
    consolidatedAt: string;
    pageRank?: number;
    communityId?: number;
    entityType?: "person" | "location" | "project" | "tool" | "topic";
    aliases?: string[];
    mentionCount?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    weight: number;
    type:
      | "SIMILAR_TO"
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
    confidence?: number;
    relationshipHint?: string;
  }>;
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    episodicNodeCount: number;
    semanticNodeCount: number;
    similarityEdgeCount: number;
    semanticEdgeCount: number;
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
  };
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

  // STM
  static async addEpisodicLog(
    sessionId: string,
    actor: Actor,
    rawText: string
  ): Promise<string | undefined> {
    const res = await fetch(`${API}/stm/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, actor, rawText }),
    });
    const data = await json<{ interactionId: string }>(res);
    return data.interactionId;
  }

  static async getRecentContext(
    sessionId: string,
    limitCount: number = 10
  ): Promise<EpisodicMemory[]> {
    const res = await fetch(
      `${API}/stm/context/${encodeURIComponent(sessionId)}?limit=${limitCount}`
    );
    return json<EpisodicMemory[]>(res);
  }

  static async listStmEntries(options?: {
    page?: number;
    pageSize?: number;
    actor?: Actor;
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

  // MTM
  static async consolidateToMTM(
    interactionId: string,
    content: string
  ): Promise<string | undefined> {
    const res = await fetch(`${API}/mtm/consolidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interactionId, content }),
    });
    const data = await json<{ nodeId: string }>(res);
    return data.nodeId;
  }

  static async getGraph(limitCount: number = 40): Promise<GraphSnapshot> {
    const res = await fetch(`${API}/mtm/graph?limit=${limitCount}`);
    return json<GraphSnapshot>(res);
  }

  // Sleep-Cycle
  static async runSleepCycle(): Promise<{
    pruned: number;
    consolidated: number;
  } | null> {
    const res = await fetch(`${API}/consolidation/sleep-cycle`, {
      method: "POST",
    });
    return json<{ pruned: number; consolidated: number } | null>(res);
  }

  // LTM
  static async searchLTM(
    queryText: string,
    limitCount: number = 3
  ): Promise<SemanticFact[]> {
    const res = await fetch(
      `${API}/ltm/search?q=${encodeURIComponent(queryText)}&limit=${limitCount}`
    );
    return json<SemanticFact[]>(res);
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

  static async getStats(): Promise<{
    stm: number;
    mtm: number;
    ltm: number;
  }> {
    const res = await fetch(`${API}/memory/stats`);
    const data = await json<{
      tiers: {
        stm: { count: number };
        mtm: { count: number };
        ltm: { count: number };
      };
    }>(res);
    return {
      stm: data.tiers.stm.count,
      mtm: data.tiers.mtm.count,
      ltm: data.tiers.ltm.count,
    };
  }
}
