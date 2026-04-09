import { Router } from "express";

import { listJobs, listPipelineEvents } from "../services/jobService.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const jobs = await listJobs(limit);
    res.json(jobs);
  } catch (error) {
    console.error("Job list error:", error);
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

router.get("/events", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined;
    const documentId = req.query.documentId ? String(req.query.documentId) : undefined;
    const events = await listPipelineEvents({ limit, jobId, documentId });
    res.json(events);
  } catch (error) {
    console.error("Pipeline events error:", error);
    res.status(500).json({ error: "Failed to load pipeline events" });
  }
});

export default router;