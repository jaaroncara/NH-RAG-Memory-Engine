import { Router } from "express";
import { z } from "zod";
import { addEpisodicLog, getRecentContext } from "../services/stmService.js";

const router = Router();

const logSchema = z.object({
  sessionId: z.string().min(1),
  actor: z.enum(["user", "agent", "system"]),
  rawText: z.string().min(1).max(5120),
});

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
