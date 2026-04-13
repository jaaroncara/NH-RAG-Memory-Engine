import { searchLTM, type SemanticFact } from "./ltmService.js";
import { getRecentContext, type EpisodicMemory } from "./stmService.js";

export interface CombinedRetrievalContext {
  sessionId: string;
  query: string;
  stmContext: EpisodicMemory[];
  ltmMatches: SemanticFact[];
  retrievalSummary: {
    stmCount: number;
    ltmCount: number;
    contextLimit: number;
    semanticLimit: number;
  };
}

export async function getCombinedRetrievalContext(input: {
  sessionId: string;
  query: string;
  contextLimit?: number;
  semanticLimit?: number;
}): Promise<CombinedRetrievalContext> {
  const contextLimit = Math.min(Math.max(input.contextLimit ?? 10, 1), 50);
  const semanticLimit = Math.min(Math.max(input.semanticLimit ?? 5, 1), 20);

  const [stmContext, ltmMatches] = await Promise.all([
    getRecentContext(input.sessionId, contextLimit),
    searchLTM(input.query, semanticLimit),
  ]);

  return {
    sessionId: input.sessionId,
    query: input.query,
    stmContext,
    ltmMatches,
    retrievalSummary: {
      stmCount: stmContext.length,
      ltmCount: ltmMatches.length,
      contextLimit,
      semanticLimit,
    },
  };
}