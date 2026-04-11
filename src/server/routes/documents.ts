import { Router } from "express";
import multer from "multer";

import { getDocumentDetail, importUploadedDocuments, listDocuments } from "../services/documentService.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10,
    fileSize: 20 * 1024 * 1024,
  },
});

router.get("/", async (_req, res) => {
  try {
    const documents = await listDocuments();
    res.json(documents);
  } catch (error) {
    console.error("Document list error:", error);
    res.status(500).json({ error: "Failed to load documents" });
  }
});

router.post("/import", upload.array("files", 10), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "At least one file is required" });
      return;
    }

    const imported = await importUploadedDocuments(files);
    res.status(202).json({ documents: imported });
  } catch (error) {
    console.error("Document import error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to import documents" });
  }
});

router.get("/:documentId", async (req, res) => {
  try {
    const detail = await getDocumentDetail(req.params.documentId);
    if (!detail) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(detail);
  } catch (error) {
    console.error("Document detail error:", error);
    res.status(500).json({ error: "Failed to load document detail" });
  }
});

export default router;