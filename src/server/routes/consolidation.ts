import { Router } from "express";
import { runSleepCycle } from "../services/consolidationService.js";

const router = Router();

router.post("/sleep-cycle", async (req, res) => {
  try {
    const result = await runSleepCycle();
    res.status(202).json(result);
  } catch (error) {
    console.error("Sleep-cycle error:", error);
    res.status(500).json({ error: "Sleep-cycle consolidation failed" });
  }
});

export default router;
