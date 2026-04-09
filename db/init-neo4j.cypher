// Neo4j initialization constraints (run once via driver or browser)
// These are executed programmatically in src/server/db/neo4j.ts on startup

// Uniqueness constraint on EpisodicNode
// CREATE CONSTRAINT episodic_node_id IF NOT EXISTS
//   FOR (n:EpisodicNode) REQUIRE n.nodeId IS UNIQUE;

// Uniqueness constraint on SemanticNode
// CREATE CONSTRAINT semantic_node_id IF NOT EXISTS
//   FOR (n:SemanticNode) REQUIRE n.entityId IS UNIQUE;
