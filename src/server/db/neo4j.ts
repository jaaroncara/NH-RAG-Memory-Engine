import neo4j, { Driver } from "neo4j-driver";

let driver: Driver;

export function getNeo4jDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI || "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER || "neo4j",
        process.env.NEO4J_PASSWORD || ""
      )
    );
  }
  return driver;
}

export async function initNeo4j(): Promise<void> {
  const d = getNeo4jDriver();
  const session = d.session();
  try {
    // Create constraints
    await session.run(
      "CREATE CONSTRAINT episodic_node_id IF NOT EXISTS FOR (n:EpisodicNode) REQUIRE n.nodeId IS UNIQUE"
    );
    await session.run(
      "CREATE CONSTRAINT semantic_node_id IF NOT EXISTS FOR (n:SemanticNode) REQUIRE n.entityId IS UNIQUE"
    );
    console.log("Neo4j constraints initialized");
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
  }
}
