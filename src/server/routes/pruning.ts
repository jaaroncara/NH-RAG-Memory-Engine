import { Router } from "express";
import { z } from "zod";
import { getPruningConfig, updatePruningConfig } from "../config/pruningConfig.js";

const router = Router();

const UpdateSchema = z.object({
  stmMaxAgeHours: z.number().int().min(1).max(720).optional(),
  stmMaxRowsPerSession: z.number().int().min(10).max(5000).optional(),
  ltmDormancyDays: z.number().int().min(1).max(365).optional(),
  ltmSimilarityThreshold: z.number().min(0.50).max(0.99).optional(),
});

router.get("/", (req, res) => {
  res.json(getPruningConfig());
});

router.put("/", (req, res) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  const updated = updatePruningConfig(parsed.data);
  res.json(updated);
});

export default router;
