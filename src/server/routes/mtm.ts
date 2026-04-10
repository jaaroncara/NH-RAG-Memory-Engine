import { Router } from "express";
import { z } from "zod";
import { consolidateToMTM, getGraphSnapshot, refreshMtmGraphAnalytics } from "../services/mtmService.js";

const router = Router();

const consolidateSchema = z.object({
  interactionId: z.string().min(1),
  content: z.string().min(1),
});

router.post("/consolidate", async (req, res) => {
  try {
    const body = consolidateSchema.parse(req.body);
    const id = await consolidateToMTM(body.interactionId, body.content);

    let analyticsRefreshed = true;
    try {
      await refreshMtmGraphAnalytics();
    } catch (error) {
      analyticsRefreshed = false;
      console.error("MTM analytics refresh error:", error);
    }

    res.status(201).json({ nodeId: id, analyticsRefreshed });
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
    const rawLimit = typeof req.query.limit === "string" ? req.query.limit : undefined;
    const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 1, 1), 500) : undefined;
    const graph = await getGraphSnapshot(limit);
    res.json(graph);
  } catch (error) {
    console.error("MTM graph error:", error);
    res.status(500).json({ error: "Failed to load MTM graph" });
  }
});

export default router;
