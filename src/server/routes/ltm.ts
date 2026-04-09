import { Router } from "express";
import { searchLTM } from "../services/ltmService.js";

const router = Router();

router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    if (!q) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 3, 20);
    const facts = await searchLTM(q, limit);
    res.json(facts);
  } catch (error) {
    console.error("LTM search error:", error);
    res.status(500).json({ error: "Failed to search LTM" });
  }
});

export default router;
