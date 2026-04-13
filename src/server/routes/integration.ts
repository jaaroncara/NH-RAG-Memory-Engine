import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import { pool } from "../db/index.js";
import { getNeo4jDriver } from "../db/neo4j.js";
import { getIntegrationRoutePrefix, isIntegrationAuthEnabled } from "../config/integration.js";
import { getDocumentDetail, importUploadedDocumentsWithOptions, listDocuments } from "../services/documentService.js";
import { getJob, listJobs, listPipelineEvents } from "../services/jobService.js";
import { searchLTM } from "../services/ltmService.js";
import { getCombinedRetrievalContext } from "../services/retrievalService.js";
import { addEpisodicLog, getRecentContext } from "../services/stmService.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10,
    fileSize: 20 * 1024 * 1024,
  },
});

const actorSchema = z.enum(["user", "agent", "system"]);
const metadataSchema = z.record(z.string(), z.unknown());
const sharedIntegrationSchema = z.object({
  sourceApp: z.string().min(1).max(120).optional(),
  agentId: z.string().min(1).max(120).optional(),
  namespace: z.string().min(1).max(120).optional(),
  externalConversationId: z.string().min(1).max(240).optional(),
  metadata: metadataSchema.optional(),
});

const chatLogSchema = sharedIntegrationSchema.extend({
  sessionId: z.string().min(1).max(240),
  actor: actorSchema,
  rawText: z.string().min(1).max(5120),
  externalMessageId: z.string().min(1).max(240).optional(),
  externalTimestamp: z.string().datetime().optional(),
});

const chatLogBatchSchema = sharedIntegrationSchema.extend({
  sessionId: z.string().min(1).max(240),
  logs: z
    .array(
      z.object({
        actor: actorSchema,
        rawText: z.string().min(1).max(5120),
        externalMessageId: z.string().min(1).max(240).optional(),
        externalTimestamp: z.string().datetime().optional(),
        metadata: metadataSchema.optional(),
      })
    )
    .min(1)
    .max(200),
});

const retrievalSchema = z.object({
  sessionId: z.string().min(1).max(240),
  query: z.string().min(1).max(4096),
  contextLimit: z.number().int().min(1).max(50).optional(),
  semanticLimit: z.number().int().min(1).max(20).optional(),
});

const documentImportFieldsSchema = z.object({
  sourceApp: z.string().min(1).max(120).optional(),
  agentId: z.string().min(1).max(120).optional(),
  namespace: z.string().min(1).max(120).optional(),
  externalConversationId: z.string().min(1).max(240).optional(),
  metadata: z.string().optional(),
});

router.get("/health", async (_req, res) => {
  const services: Record<string, string> = {};
  let status: "ok" | "degraded" = "ok";

  try {
    await pool.query("SELECT 1");
    services.postgres = "ok";
  } catch {
    services.postgres = "error";
    status = "degraded";
  }

  try {
    const session = getNeo4jDriver().session();
    try {
      await session.run("RETURN 1");
    } finally {
      await session.close();
    }
    services.neo4j = "ok";
  } catch {
    services.neo4j = "error";
    status = "degraded";
  }

  res.status(status === "ok" ? 200 : 503).json({
    service: "nh-rag-memory",
    status,
    authRequired: isIntegrationAuthEnabled(),
    routePrefix: getIntegrationRoutePrefix(),
    services,
    timestamp: new Date().toISOString(),
  });
});

router.post("/chat-logs", async (req, res) => {
  try {
    const body = chatLogSchema.parse(req.body);
    const interactionId = await addEpisodicLog(body.sessionId, body.actor, body.rawText, {
      sourceType: "integration_chat",
      metadata: buildIntegrationMetadata(body),
    });

    res.status(201).json({
      accepted: true,
      interactionId,
      sessionId: body.sessionId,
    });
  } catch (error) {
    handleRouteError(res, "Integration chat-log write failed", error, "Failed to write chat log");
  }
});

router.post("/chat-logs/batch", async (req, res) => {
  try {
    const body = chatLogBatchSchema.parse(req.body);
    const interactionIds: string[] = [];

    for (const log of body.logs) {
      const interactionId = await addEpisodicLog(body.sessionId, log.actor, log.rawText, {
        sourceType: "integration_chat",
        metadata: buildIntegrationMetadata(body, log),
      });
      interactionIds.push(interactionId);
    }

    res.status(201).json({
      accepted: true,
      sessionId: body.sessionId,
      count: interactionIds.length,
      interactionIds,
    });
  } catch (error) {
    handleRouteError(res, "Integration chat-log batch write failed", error, "Failed to write chat-log batch");
  }
});

router.get("/sessions/:sessionId/context", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const entries = await getRecentContext(req.params.sessionId, limit);
    res.json({
      sessionId: req.params.sessionId,
      count: entries.length,
      entries,
    });
  } catch (error) {
    handleRouteError(res, "Integration session-context read failed", error, "Failed to retrieve session context");
  }
});

router.get("/ltm/search", async (req, res) => {
  try {
    const queryText = String(req.query.q || "").trim();
    if (!queryText) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 5, 20);
    const matches = await searchLTM(queryText, limit);
    res.json({
      query: queryText,
      limit,
      matches,
    });
  } catch (error) {
    handleRouteError(res, "Integration LTM search failed", error, "Failed to search long-term memory");
  }
});

router.post("/retrieval/context", async (req, res) => {
  try {
    const body = retrievalSchema.parse(req.body);
    const result = await getCombinedRetrievalContext(body);
    res.json(result);
  } catch (error) {
    handleRouteError(res, "Integration combined retrieval failed", error, "Failed to retrieve NH-RAG context");
  }
});

router.get("/documents", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const documents = await listDocuments({ limit });
    res.json({ documents });
  } catch (error) {
    handleRouteError(res, "Integration document list failed", error, "Failed to load documents");
  }
});

router.post("/documents/import", upload.array("files", 10), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "At least one file is required" });
      return;
    }

    const parsedFields = documentImportFieldsSchema.parse(req.body);
    const metadata = buildDocumentIntegrationMetadata(parsedFields);
    const documents = await importUploadedDocumentsWithOptions(files, {
      metadata,
    });

    res.status(202).json({
      accepted: true,
      documents,
      jobIds: [...new Set(documents.map((document) => document.statusSummary.jobId).filter(Boolean))],
    });
  } catch (error) {
    handleRouteError(res, "Integration document import failed", error, "Failed to import documents");
  }
});

router.get("/documents/:documentId", async (req, res) => {
  try {
    const detail = await getDocumentDetail(req.params.documentId);
    if (!detail) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    res.json(detail);
  } catch (error) {
    handleRouteError(res, "Integration document detail failed", error, "Failed to load document detail");
  }
});

router.get("/jobs", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const jobs = await listJobs(limit);
    res.json({ jobs });
  } catch (error) {
    handleRouteError(res, "Integration job list failed", error, "Failed to load jobs");
  }
});

router.get("/jobs/:jobId/events", async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const events = await listPipelineEvents({ jobId: job.jobId, limit });
    res.json({
      jobId: job.jobId,
      events,
    });
  } catch (error) {
    handleRouteError(res, "Integration job-event lookup failed", error, "Failed to load job events");
  }
});

router.get("/jobs/:jobId", async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.json(job);
  } catch (error) {
    handleRouteError(res, "Integration job lookup failed", error, "Failed to load job");
  }
});

export default router;

function buildIntegrationMetadata(
  shared: {
    sourceApp?: string;
    agentId?: string;
    namespace?: string;
    externalConversationId?: string;
    metadata?: Record<string, unknown>;
  },
  entry?: {
    externalMessageId?: string;
    externalTimestamp?: string;
    metadata?: Record<string, unknown>;
  }
) {
  return compactRecord({
    ingestedVia: "integration-api",
    sourceApp: shared.sourceApp,
    agentId: shared.agentId,
    namespace: shared.namespace,
    externalConversationId: shared.externalConversationId,
    externalMessageId: entry?.externalMessageId,
    externalTimestamp: entry?.externalTimestamp,
    clientMetadata: shared.metadata,
    entryMetadata: entry?.metadata,
  });
}

function buildDocumentIntegrationMetadata(input: z.infer<typeof documentImportFieldsSchema>) {
  return compactRecord({
    ingestedVia: "integration-api",
    sourceApp: input.sourceApp,
    agentId: input.agentId,
    namespace: input.namespace,
    externalConversationId: input.externalConversationId,
    clientMetadata: parseOptionalMetadataJson(input.metadata),
  });
}

function parseOptionalMetadataJson(value: string | undefined) {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Document metadata must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function handleRouteError(
  res: Response,
  logMessage: string,
  error: unknown,
  fallback: string
) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues });
    return;
  }

  const message = error instanceof Error ? error.message : fallback;
  console.error(logMessage, error);
  res.status(500).json({ error: message });
}