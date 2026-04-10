import { type Response, Router } from "express";
import { z } from "zod";

import {
  executeCypherQuery,
  executeSqlQuery,
  inspectCypherQuery,
  inspectSqlQuery,
} from "../services/queryExecutionService.js";

const router = Router();

const querySchema = z.object({
  query: z.string().min(1).max(20_000),
  timeoutMs: z.number().int().positive().max(15_000).optional(),
  maxRows: z.number().int().positive().max(250).optional(),
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