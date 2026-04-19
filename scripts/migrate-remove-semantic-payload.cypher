// One-time migration: remove legacy scalar properties from MemoryNodes
// and clean up stale SIMILARITY edge properties.
// Run via Neo4j Browser or: cypher-shell -u neo4j -p <password> -f scripts/migrate-remove-semantic-payload.cypher

// Remove legacy semantic payload properties baked into MemoryNodes.
// Entity context is now exclusively in bipartite MENTIONS edges.
MATCH (n:MemoryNode)
WHERE n.semanticPayloadJson IS NOT NULL
   OR n.semanticEntityKeys IS NOT NULL
REMOVE n.semanticPayloadJson,
       n.semanticEntityKeys,
       n.semanticEntityNames,
       n.semanticEntityTypes,
       n.semanticRelationshipTypes,
       n.semanticEntityCount,
       n.semanticMaxConfidence;

// Remove cosineWeight from SIMILARITY edges.
// weight is the canonical property written by gds.knn.write.
MATCH ()-[r:SIMILARITY]-()
WHERE r.cosineWeight IS NOT NULL
REMOVE r.cosineWeight;

// Clear all existing SIMILARITY edges so the next sleep cycle
// rebuilds them cleanly via GDS KNN from scratch.
MATCH ()-[r:SIMILARITY]-()
DELETE r;
