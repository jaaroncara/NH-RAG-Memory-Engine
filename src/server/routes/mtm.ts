import { Router } from "express";
import { z } from "zod";
import { consolidateToMTM, getGraphSnapshot } from "../services/mtmService.js";

const router = Router();

const consolidateSchema = z.object({
  interactionId: z.string().min(1),
  content: z.string().min(1),
});

router.post("/consolidate", async (req, res) => {
  try {
    const body = consolidateSchema.parse(req.body);
    const id = await consolidateToMTM(body.interactionId, body.content);
    res.status(201).json({ nodeId: id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    console.error("MTM consolidate error:", error);
    res.status(500).json({ error: "Failed to consolidate to MTM" });
  }
});

router.get("/graph", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 120);
    const graph = await getGraphSnapshot(limit);
    res.json(graph);
  } catch (error) {
    console.error("MTM graph error:", error);
    res.status(500).json({ error: "Failed to load MTM graph" });
  }
});

export default router;
