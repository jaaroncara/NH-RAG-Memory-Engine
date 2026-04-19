// MTM Graph Migration: EpisodicNode/ChunkNode → DocumentMemory/ChatMemory
//
// Run this against Neo4j ONCE to migrate existing nodes to the new schema.
// All new nodes are labeled :MemoryNode with a specific :DocumentMemory or :ChatMemory sub-label.
// All similarity edges are renamed from SIMILAR_TO → SIMILARITY.
// TopicNode and MENTIONS edges are unchanged.
//
// Step 1: Add :MemoryNode + :DocumentMemory to existing document chunk nodes
MATCH (n:ChunkNode)
WHERE NOT n:MemoryNode
SET n:MemoryNode:DocumentMemory, n.memoryType = 'document'
REMOVE n:EpisodicNode, n:ChunkNode;

// Step 2: Add :MemoryNode + :ChatMemory to remaining EpisodicNode (chat memory)
MATCH (n:EpisodicNode)
WHERE NOT n:MemoryNode
SET n:MemoryNode:ChatMemory, n.memoryType = 'chat'
REMOVE n:EpisodicNode;

// Step 3: Rename SIMILAR_TO relationships to SIMILARITY
MATCH (a:MemoryNode)-[old:SIMILAR_TO]-(b:MemoryNode)
WHERE id(a) < id(b)
MERGE (a)-[new:SIMILARITY]-(b)
SET new.weight = coalesce(old.cosineWeight, old.weight, 0.75),
    new.cosineWeight = coalesce(old.cosineWeight, old.weight, 0.75),
    new.updatedAt = coalesce(old.updatedAt, toString(datetime()))
WITH old
DELETE old;

// Step 4: Drop old EpisodicNode uniqueness constraint (if it exists)
DROP CONSTRAINT episodic_node_id IF EXISTS;

// Step 5: Create new constraints (idempotent — also done by initNeo4j on restart)
CREATE CONSTRAINT memory_node_id IF NOT EXISTS FOR (n:MemoryNode) REQUIRE n.nodeId IS UNIQUE;
CREATE CONSTRAINT topic_node_id IF NOT EXISTS FOR (t:TopicNode) REQUIRE t.topicId IS UNIQUE;
