import { db } from "../db/index.js";
import { shortTermMemory } from "../db/schema.js";
import { eq, desc, sql } from "drizzle-orm";

export type Actor = "user" | "agent" | "system";

export interface EpisodicMemory {
  interactionId: string;
  sessionId: string;
  timestamp: string;
  actor: Actor;
  rawText: string;
}

export async function addEpisodicLog(
  sessionId: string,
  actor: Actor,
  rawText: string
): Promise<string> {
  const [row] = await db
    .insert(shortTermMemory)
    .values({ sessionId, actor, rawText })
    .returning({ id: shortTermMemory.interactionId });
  return row.id;
}

export async function getRecentContext(
  sessionId: string,
  limitCount: number = 10
): Promise<EpisodicMemory[]> {
  const rows = await db
    .select()
    .from(shortTermMemory)
    .where(eq(shortTermMemory.sessionId, sessionId))
    .orderBy(desc(shortTermMemory.timestamp))
    .limit(limitCount);

  return rows
    .map((r) => ({
      interactionId: r.interactionId,
      sessionId: r.sessionId,
      timestamp: r.timestamp.toISOString(),
      actor: r.actor as Actor,
      rawText: r.rawText,
    }))
    .reverse();
}

export async function getStmCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shortTermMemory);
  return row.count;
}
