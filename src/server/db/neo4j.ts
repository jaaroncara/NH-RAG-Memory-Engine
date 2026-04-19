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
    await session.run(
      "CREATE CONSTRAINT memory_node_id IF NOT EXISTS FOR (n:MemoryNode) REQUIRE n.nodeId IS UNIQUE"
    );
    await session.run(
      "CREATE CONSTRAINT topic_node_id IF NOT EXISTS FOR (t:TopicNode) REQUIRE t.topicId IS UNIQUE"
    );
    await session.run(
      "CREATE INDEX memory_node_memory_type IF NOT EXISTS FOR (n:MemoryNode) ON (n.memoryType)"
    );
    await session.run(
      "CREATE INDEX memory_node_consolidated_at IF NOT EXISTS FOR (n:MemoryNode) ON (n.consolidatedAt)"
    );
    await session.run(
      "CREATE INDEX memory_node_community_id IF NOT EXISTS FOR (n:MemoryNode) ON (n.communityId)"
    );
    await session.run(
      "CREATE INDEX memory_node_page_rank IF NOT EXISTS FOR (n:MemoryNode) ON (n.pageRank)"
    );
    console.log("Neo4j constraints and indexes initialized");
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
  }
}
