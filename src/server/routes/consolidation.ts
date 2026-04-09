import { Router } from "express";
import { runSleepCycle } from "../services/consolidationService.js";

const router = Router();

router.post("/sleep-cycle", async (req, res) => {
  try {
    const result = await runSleepCycle();
    if (!result) {
      res.json({ message: "Not enough data for consolidation", pruned: 0, consolidated: 0 });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error("Sleep-cycle error:", error);
    res.status(500).json({ error: "Sleep-cycle consolidation failed" });
  }
});

export default router;
