import { Router } from "express";

import { getOverviewMetrics } from "../services/metricsService.js";

const router = Router();

router.get("/overview", async (_req, res) => {
  try {
    const metrics = await getOverviewMetrics();
    res.json(metrics);
  } catch (error) {
    console.error("Metrics error:", error);
    res.status(500).json({ error: "Failed to load overview metrics" });
  }
});

export default router;