import { type Response, Router } from "express";
import { z } from "zod";

import {
  executeCypherQuery,
  executeSqlQuery,
  inspectCypherQuery,
  inspectSqlQuery,
} from "../services/queryExecutionService.js";
import {
  CLEAR_ALL_CYPHER_SNIPPET,
  CLEAR_ALL_SQL_SNIPPET,
  KNOWLEDGE_BASE_CLEAR_CONFIRMATION,
} from "../../shared/knowledgeBaseReset.js";

const router = Router();

const querySchema = z.object({
  query: z.string().min(1).max(20_000),
  timeoutMs: z.number().int().positive().max(15_000).optional(),
  maxRows: z.number().int().positive().max(250).optional(),
});

const clearAllSchema = z.object({
  confirmation: z.literal(KNOWLEDGE_BASE_CLEAR_CONFIRMATION),
});

router.post("/sql/inspect", async (req, res) => {
  try {
    const body = querySchema.parse(req.body);
    const result = inspectSqlQuery(body.query, body);
    res.json(result);
  } catch (error) {
    handleRouteError(res, "SQL inspect failed", error);
  }
});

router.post("/sql/execute", async (req, res) => {
  try {
    const body = querySchema.parse(req.body);
    const result = await executeSqlQuery(body.query, body);
    res.json(result);
  } catch (error) {
    handleRouteError(res, "SQL execute failed", error);
  }
});

router.post("/cypher/inspect", async (req, res) => {
  try {
    const body = querySchema.parse(req.body);
    const result = inspectCypherQuery(body.query, body);
    res.json(result);
  } catch (error) {
    handleRouteError(res, "Cypher inspect failed", error);
  }
});

router.post("/cypher/execute", async (req, res) => {
  try {
    const body = querySchema.parse(req.body);
    const result = await executeCypherQuery(body.query, body);
    res.json(result);
  } catch (error) {
    handleRouteError(res, "Cypher execute failed", error);
  }
});

router.post("/clear-all", async (req, res) => {
  try {
    clearAllSchema.parse(req.body);

    // Clear the derived graph first so a partial failure leaves the primary stores intact.
    const cypherResult = await executeCypherQuery(CLEAR_ALL_CYPHER_SNIPPET, {
      timeoutMs: 15_000,
      maxRows: 25,
    });
    const sqlResult = await executeSqlQuery(CLEAR_ALL_SQL_SNIPPET, {
      timeoutMs: 15_000,
      maxRows: 25,
    });

    res.json({
      message: "All knowledge bases cleared. Tables, indexes, constraints, and graph schema remain intact.",
      clearedAt: new Date().toISOString(),
      sqlQuery: CLEAR_ALL_SQL_SNIPPET,
      cypherQuery: CLEAR_ALL_CYPHER_SNIPPET,
      sqlResult,
      cypherResult,
    });
  } catch (error) {
    handleRouteError(res, "Clear-all knowledge base action failed", error);
  }
});

export default router;

function handleRouteError(
  res: Response,
  logMessage: string,
  error: unknown
) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(logMessage, error);
  res.status(500).json({ error: message });
}