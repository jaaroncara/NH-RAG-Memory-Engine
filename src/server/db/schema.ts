import { pgTable, text, timestamp, uuid, customType } from "drizzle-orm/pg-core";

// Custom pgvector type for Drizzle
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/[\[\]]/g, "")
      .split(",")
      .map(Number);
  },
});

export const shortTermMemory = pgTable("short_term_memory", {
  interactionId: uuid("interaction_id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  rawText: text("raw_text").notNull(),
});

export const longTermMemory = pgTable("long_term_memory", {
  knowledgeId: uuid("knowledge_id").primaryKey().defaultRandom(),
  distilledFact: text("distilled_fact").notNull(),
  embedding: vector("embedding").notNull(),
  lastAccessed: timestamp("last_accessed", { withTimezone: true }).notNull().defaultNow(),
  provenance: text("provenance").array().default([]),
});
