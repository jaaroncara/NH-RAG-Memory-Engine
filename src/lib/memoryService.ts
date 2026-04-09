// NH-RAG Frontend Memory Service — HTTP client for Express API

export enum Actor {
  USER = "user",
  AGENT = "agent",
  SYSTEM = "system",
}

export interface EpisodicMemory {
  interactionId?: string;
  sessionId: string;
  timestamp: string;
  actor: Actor;
  rawText: string;
}

export interface SemanticFact {
  knowledgeId: string;
  distilledFact: string;
  embedding: number[];
  lastAccessed: string;
  provenance?: string[];
  score?: number;
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

  // Health / Stats
  static async testConnection(): Promise<void> {
    try {
      await fetch(`${API}/health`);
    } catch (error) {
      console.error("Health check failed:", error);
    }
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
