import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import morgan from "morgan";

import { pool } from "./src/server/db/index.js";
import { initNeo4j, closeNeo4j } from "./src/server/db/neo4j.js";
import { getStmCount } from "./src/server/services/stmService.js";
import { getMtmCount } from "./src/server/services/mtmService.js";
import { getLtmCount } from "./src/server/services/ltmService.js";

import stmRoutes from "./src/server/routes/stm.js";
import mtmRoutes from "./src/server/routes/mtm.js";
import ltmRoutes from "./src/server/routes/ltm.js";
import consolidationRoutes from "./src/server/routes/consolidation.js";
import documentRoutes from "./src/server/routes/documents.js";
import jobRoutes from "./src/server/routes/jobs.js";
import metricsRoutes from "./src/server/routes/metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(morgan("dev"));
  app.use(express.json({ limit: "10mb" }));

  // Initialize databases
  try {
    await pool.query("SELECT 1");
    console.log("PostgreSQL connected");
  } catch (err) {
    console.error("PostgreSQL connection failed:", err);
  }

  try {
    await initNeo4j();
    console.log("Neo4j connected");
  } catch (err) {
    console.error("Neo4j connection failed:", err);
  }

  // API routes
  app.use("/api/stm", stmRoutes);
  app.use("/api/mtm", mtmRoutes);
  app.use("/api/ltm", ltmRoutes);
  app.use("/api/consolidation", consolidationRoutes);
  app.use("/api/documents", documentRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/metrics", metricsRoutes);

  app.get("/api/health", async (req, res) => {
    const health: Record<string, string> = {};
    try {
      await pool.query("SELECT 1");
      health.postgres = "ok";
    } catch {
      health.postgres = "error";
    }
    try {
      const { getNeo4jDriver } = await import("./src/server/db/neo4j.js");
      const s = getNeo4jDriver().session();
      await s.run("RETURN 1");
      await s.close();
      health.neo4j = "ok";
    } catch {
      health.neo4j = "error";
    }
    res.json({ status: "ok", services: health });
  });

  app.get("/api/memory/stats", async (req, res) => {
    try {
      const [stm, mtm, ltm] = await Promise.all([
        getStmCount(),
        getMtmCount(),
        getLtmCount(),
      ]);
      res.json({
        tiers: {
          stm: { count: stm, type: "PostgreSQL (Relational)" },
          mtm: { count: mtm, type: "Neo4j (Graph + GDS)" },
          ltm: { count: ltm, type: "PostgreSQL (pgvector)" },
        },
      });
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: "Failed to retrieve stats" });
    }
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

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await pool.end();
    await closeNeo4j();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer();
