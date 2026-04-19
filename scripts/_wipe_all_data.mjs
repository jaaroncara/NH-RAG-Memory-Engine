// One-shot wipe script — safe to delete after use
import pg from "pg";
import neo4j from "neo4j-driver";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env manually
const envPath = resolve(process.cwd(), ".env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([^#=\s]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { DATABASE_URL, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DATABASE_URL });

console.log("Wiping PostgreSQL tables...");
await pool.query(`
  TRUNCATE pipeline_events, ingestion_jobs, document_chunks, documents CASCADE;
  TRUNCATE short_term_memory;
  TRUNCATE long_term_memory;
`);
console.log("  ✓ pipeline_events, ingestion_jobs, document_chunks, documents (+ cascade)");
console.log("  ✓ short_term_memory");
console.log("  ✓ long_term_memory");
await pool.end();

// ── Neo4j ─────────────────────────────────────────────────────────────────────
console.log("\nWiping Neo4j graph...");
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
const session = driver.session();
try {
  const result = await session.run("MATCH (n) DETACH DELETE n");
  console.log(`  ✓ All nodes and relationships deleted (${result.summary.counters.updates().nodesDeleted} nodes, ${result.summary.counters.updates().relationshipsDeleted} relationships)`);
} finally {
  await session.close();
  await driver.close();
}

console.log("\nDone. All tiers are empty and ready for fresh data.");
