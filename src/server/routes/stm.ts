import { Router } from "express";
import { z } from "zod";
import { Actor, addEpisodicLog, getRecentContext, listStmEntries } from "../services/stmService.js";

const router = Router();

const logSchema = z.object({
  sessionId: z.string().min(1),
  actor: z.enum(["user", "agent", "system"]),
  rawText: z.string().min(1).max(5120),
});

const actorSchema = z.enum(["user", "agent", "system", "document"]);

router.post("/log", async (req, res) => {
  try {
    const body = logSchema.parse(req.body);
    const id = await addEpisodicLog(body.sessionId, body.actor, body.rawText);
    res.status(201).json({ interactionId: id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    console.error("STM log error:", error);
    res.status(500).json({ error: "Failed to log episodic memory" });
  }
});

router.get("/entries", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const actor = req.query.actor ? actorSchema.parse(req.query.actor) : undefined;
    const documentId = req.query.documentId ? String(req.query.documentId) : undefined;
    const query = req.query.q ? String(req.query.q) : undefined;

    const result = await listStmEntries({
      page,
      pageSize,
      actor: actor as Actor | undefined,
      documentId,
      query,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    console.error("STM explorer error:", error);
    res.status(500).json({ error: "Failed to retrieve STM entries" });
  }
});

router.get("/context/:sessionId", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const logs = await getRecentContext(req.params.sessionId, limit);
    res.json(logs);
  } catch (error) {
    console.error("STM context error:", error);
    res.status(500).json({ error: "Failed to retrieve context" });
  }
});

export default router;
