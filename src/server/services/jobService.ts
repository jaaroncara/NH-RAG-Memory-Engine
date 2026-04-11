import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { ingestionJobs, pipelineEvents } from "../db/schema.js";

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

export interface PipelineEventRecord {
  eventId: string;
  jobId: string | null;
  documentId: string | null;
  stage: string;
  level: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function createJob(input: {
  documentId?: string;
  jobType: string;
  stage: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const [row] = await db
    .insert(ingestionJobs)
    .values({
      documentId: input.documentId,
      jobType: input.jobType,
      stage: input.stage,
      metadata: input.metadata ?? {},
    })
    .returning({ id: ingestionJobs.jobId });

  return row.id;
}

export async function markJobRunning(jobId: string, stage: string, progress: number) {
  await db
    .update(ingestionJobs)
    .set({
      status: "running",
      stage,
      progress,
      startedAt: sql`coalesce(${ingestionJobs.startedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(eq(ingestionJobs.jobId, jobId));
}

export async function markJobCompleted(
  jobId: string,
  stage: string,
  progress: number,
  metadata?: Record<string, unknown>
) {
  await db
    .update(ingestionJobs)
    .set({
      status: "completed",
      stage,
      progress,
      completedAt: new Date(),
      updatedAt: new Date(),
      metadata: metadata ?? {},
    })
    .where(eq(ingestionJobs.jobId, jobId));
}

export async function markJobFailed(jobId: string, stage: string, errorMessage: string) {
  await db
    .update(ingestionJobs)
    .set({
      status: "failed",
      stage,
      errorMessage,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ingestionJobs.jobId, jobId));
}

export async function recordPipelineEvent(input: {
  jobId?: string;
  documentId?: string;
  stage: string;
  level?: string;
  message: string;
  payload?: Record<string, unknown>;
}) {
  await db.insert(pipelineEvents).values({
    jobId: input.jobId,
    documentId: input.documentId,
    stage: input.stage,
    level: input.level ?? "info",
    message: input.message,
    payload: input.payload ?? {},
  });
}

export async function listJobs(limit = 50): Promise<JobRecord[]> {
  const rows = await db
    .select()
    .from(ingestionJobs)
    .orderBy(desc(ingestionJobs.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    jobId: row.jobId,
    documentId: row.documentId,
    jobType: row.jobType,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function listPipelineEvents(options?: {
  jobId?: string;
  documentId?: string;
  limit?: number;
}): Promise<PipelineEventRecord[]> {
  const filters = [];
  if (options?.jobId) {
    filters.push(eq(pipelineEvents.jobId, options.jobId));
  }
  if (options?.documentId) {
    filters.push(eq(pipelineEvents.documentId, options.documentId));
  }

  const rows = await db
    .select()
    .from(pipelineEvents)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(pipelineEvents.createdAt))
    .limit(options?.limit ?? 100);

  return rows.map((row) => ({
    eventId: row.eventId,
    jobId: row.jobId,
    documentId: row.documentId,
    stage: row.stage,
    level: row.level,
    message: row.message,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}