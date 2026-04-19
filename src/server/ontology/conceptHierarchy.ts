export interface ConceptMapping {
  parent: string;
  entityType: "tool" | "topic" | "project" | "person" | "location";
}

/**
 * Static ontology mapping entity canonical keys (lowercase slugs produced by
 * buildCanonicalKey) to their immediate parent concept category and entity type.
 *
 * Hierarchy levels (bottom → top):
 *   specific tool/topic → sub-category → category → top-level domain
 *
 * Top-level domains are self-referential (parent === key) so callers can
 * detect roots without null-checking.
 */
export const CONCEPT_HIERARCHY: Record<string, ConceptMapping> = {
  // ---------------------------------------------------------------------------
  // Programming languages → programming-language
  // ---------------------------------------------------------------------------
  typescript: { parent: "programming-language", entityType: "tool" },
  javascript: { parent: "programming-language", entityType: "tool" },
  python: { parent: "programming-language", entityType: "tool" },
  rust: { parent: "programming-language", entityType: "tool" },
  go: { parent: "programming-language", entityType: "tool" },
  java: { parent: "programming-language", entityType: "tool" },
  "c-sharp": { parent: "programming-language", entityType: "tool" },
  php: { parent: "programming-language", entityType: "tool" },
  ruby: { parent: "programming-language", entityType: "tool" },
  swift: { parent: "programming-language", entityType: "tool" },
  kotlin: { parent: "programming-language", entityType: "tool" },
  scala: { parent: "programming-language", entityType: "tool" },
  elixir: { parent: "programming-language", entityType: "tool" },
  "c-plus-plus": { parent: "programming-language", entityType: "tool" },
  "programming-language": { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Web frameworks → web-framework
  // ---------------------------------------------------------------------------
  react: { parent: "web-framework", entityType: "tool" },
  vue: { parent: "web-framework", entityType: "tool" },
  angular: { parent: "web-framework", entityType: "tool" },
  svelte: { parent: "web-framework", entityType: "tool" },
  "next-js": { parent: "web-framework", entityType: "tool" },
  nuxt: { parent: "web-framework", entityType: "tool" },
  remix: { parent: "web-framework", entityType: "tool" },
  astro: { parent: "web-framework", entityType: "tool" },
  sveltekit: { parent: "web-framework", entityType: "tool" },
  "web-framework": { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // UI frameworks / component libraries → ui-framework
  // ---------------------------------------------------------------------------
  "material-ui": { parent: "ui-framework", entityType: "tool" },
  "chakra-ui": { parent: "ui-framework", entityType: "tool" },
  shadcn: { parent: "ui-framework", entityType: "tool" },
  "radix-ui": { parent: "ui-framework", entityType: "tool" },
  "headless-ui": { parent: "ui-framework", entityType: "tool" },
  "ui-framework": { parent: "frontend", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Frontend tools → frontend
  // ---------------------------------------------------------------------------
  tailwind: { parent: "frontend", entityType: "tool" },
  css: { parent: "frontend", entityType: "tool" },
  sass: { parent: "frontend", entityType: "tool" },
  webpack: { parent: "frontend", entityType: "tool" },
  vite: { parent: "frontend", entityType: "tool" },
  esbuild: { parent: "frontend", entityType: "tool" },
  rollup: { parent: "frontend", entityType: "tool" },
  parcel: { parent: "frontend", entityType: "tool" },
  frontend: { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Backend tools → backend
  // ---------------------------------------------------------------------------
  "node-js": { parent: "backend", entityType: "tool" },
  express: { parent: "backend", entityType: "tool" },
  fastapi: { parent: "backend", entityType: "tool" },
  bun: { parent: "backend", entityType: "tool" },
  django: { parent: "backend", entityType: "tool" },
  flask: { parent: "backend", entityType: "tool" },
  spring: { parent: "backend", entityType: "tool" },
  rails: { parent: "backend", entityType: "tool" },
  nestjs: { parent: "backend", entityType: "tool" },
  hono: { parent: "backend", entityType: "tool" },
  deno: { parent: "backend", entityType: "tool" },
  backend: { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Databases — leaf tools map to their sub-category; sub-categories map to
  // the "database" category; "database" maps to software-engineering.
  // ---------------------------------------------------------------------------

  // Graph databases → graph-database
  neo4j: { parent: "graph-database", entityType: "tool" },
  "amazon-neptune": { parent: "graph-database", entityType: "tool" },
  "graph-database": { parent: "database", entityType: "topic" },

  // Relational databases → relational-database
  postgresql: { parent: "relational-database", entityType: "tool" },
  mysql: { parent: "relational-database", entityType: "tool" },
  sqlite: { parent: "relational-database", entityType: "tool" },
  "sql-server": { parent: "relational-database", entityType: "tool" },
  oracle: { parent: "relational-database", entityType: "tool" },
  "relational-database": { parent: "database", entityType: "topic" },

  // Document databases → document-database
  mongodb: { parent: "document-database", entityType: "tool" },
  couchdb: { parent: "document-database", entityType: "tool" },
  firestore: { parent: "document-database", entityType: "tool" },
  "document-database": { parent: "database", entityType: "topic" },

  // Vector databases → vector-database
  pgvector: { parent: "vector-database", entityType: "tool" },
  pinecone: { parent: "vector-database", entityType: "tool" },
  weaviate: { parent: "vector-database", entityType: "tool" },
  qdrant: { parent: "vector-database", entityType: "tool" },
  chroma: { parent: "vector-database", entityType: "tool" },
  milvus: { parent: "vector-database", entityType: "tool" },
  "vector-database": { parent: "database", entityType: "topic" },

  // Key-value / wide-column / search databases
  redis: { parent: "database", entityType: "tool" },
  elasticsearch: { parent: "database", entityType: "tool" },
  cassandra: { parent: "database", entityType: "tool" },
  dynamodb: { parent: "database", entityType: "tool" },

  // Database category roll-up
  database: { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Cloud platforms → cloud-platform
  // ---------------------------------------------------------------------------
  aws: { parent: "cloud-platform", entityType: "tool" },
  azure: { parent: "cloud-platform", entityType: "tool" },
  gcp: { parent: "cloud-platform", entityType: "tool" },
  vercel: { parent: "cloud-platform", entityType: "tool" },
  "digital-ocean": { parent: "cloud-platform", entityType: "tool" },
  cloudflare: { parent: "cloud-platform", entityType: "tool" },
  netlify: { parent: "cloud-platform", entityType: "tool" },
  "cloud-platform": { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // DevOps → devops
  // ---------------------------------------------------------------------------
  docker: { parent: "devops", entityType: "tool" },
  kubernetes: { parent: "devops", entityType: "tool" },
  "github-actions": { parent: "devops", entityType: "tool" },
  terraform: { parent: "devops", entityType: "tool" },
  ansible: { parent: "devops", entityType: "tool" },
  jenkins: { parent: "devops", entityType: "tool" },
  helm: { parent: "devops", entityType: "tool" },
  nginx: { parent: "devops", entityType: "tool" },
  devops: { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Testing → testing
  // ---------------------------------------------------------------------------
  jest: { parent: "testing", entityType: "tool" },
  vitest: { parent: "testing", entityType: "tool" },
  playwright: { parent: "testing", entityType: "tool" },
  cypress: { parent: "testing", entityType: "tool" },
  mocha: { parent: "testing", entityType: "tool" },
  pytest: { parent: "testing", entityType: "tool" },
  junit: { parent: "testing", entityType: "tool" },
  testing: { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Version control → version-control
  // ---------------------------------------------------------------------------
  git: { parent: "version-control", entityType: "tool" },
  github: { parent: "version-control", entityType: "tool" },
  gitlab: { parent: "version-control", entityType: "tool" },
  bitbucket: { parent: "version-control", entityType: "tool" },
  "version-control": { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Top-level software engineering domain (self-referential root)
  // ---------------------------------------------------------------------------
  "software-engineering": { parent: "software-engineering", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // AI / ML — leaf models/tools → ai-model or ai-framework → ai-ml
  // ---------------------------------------------------------------------------

  // AI models → ai-model
  openai: { parent: "ai-model", entityType: "tool" },
  anthropic: { parent: "ai-model", entityType: "tool" },
  gemini: { parent: "ai-model", entityType: "tool" },
  llama: { parent: "ai-model", entityType: "tool" },
  mistral: { parent: "ai-model", entityType: "tool" },
  cohere: { parent: "ai-model", entityType: "tool" },
  huggingface: { parent: "ai-model", entityType: "tool" },
  "ai-model": { parent: "ai-ml", entityType: "topic" },

  // AI frameworks → ai-framework
  langchain: { parent: "ai-framework", entityType: "tool" },
  llamaindex: { parent: "ai-framework", entityType: "tool" },
  "semantic-kernel": { parent: "ai-framework", entityType: "tool" },
  haystack: { parent: "ai-framework", entityType: "tool" },
  "ai-framework": { parent: "ai-ml", entityType: "topic" },

  // Retrieval Augmented Generation → retrieval-augmented-generation → ai-ml
  rag: { parent: "retrieval-augmented-generation", entityType: "topic" },
  "vector-search": { parent: "retrieval-augmented-generation", entityType: "topic" },
  embedding: { parent: "retrieval-augmented-generation", entityType: "topic" },
  "retrieval-augmented-generation": { parent: "ai-ml", entityType: "topic" },

  // Top-level AI/ML domain (self-referential root)
  "ai-ml": { parent: "ai-ml", entityType: "topic" },

  // ---------------------------------------------------------------------------
  // Memory / cognitive concepts → memory-system
  // ---------------------------------------------------------------------------
  "episodic-memory": { parent: "memory-system", entityType: "topic" },
  "semantic-memory": { parent: "memory-system", entityType: "topic" },
  "working-memory": { parent: "memory-system", entityType: "topic" },
  "long-term-memory": { parent: "memory-system", entityType: "topic" },
  "short-term-memory": { parent: "memory-system", entityType: "topic" },
  "associative-memory": { parent: "memory-system", entityType: "topic" },
  consolidation: { parent: "memory-system", entityType: "topic" },
  "memory-decay": { parent: "memory-system", entityType: "topic" },
  "memory-retrieval": { parent: "memory-system", entityType: "topic" },

  // Top-level memory domain (self-referential root)
  "memory-system": { parent: "memory-system", entityType: "topic" },
};
