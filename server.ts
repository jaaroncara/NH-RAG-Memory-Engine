import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import morgan from "morgan";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(morgan("dev"));
  app.use(express.json());

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "NH-RAG Memory Engine is running" });
  });

  // Placeholder for RESTful CRUD operations as requested
  // These will interact with Firestore via the client-side or admin SDK
  // For simplicity and security (as per guidelines), we'll keep most logic in the frontend
  // but provide these endpoints for external integration if needed.

  app.get("/api/memory/stats", (req, res) => {
    res.json({
      tiers: {
        stm: { status: "active", type: "SQL-like (Firestore)" },
        mtm: { status: "active", type: "Graph (Firestore + Graphology)" },
        ltm: { status: "active", type: "Vector (Firestore + Embeddings)" }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
