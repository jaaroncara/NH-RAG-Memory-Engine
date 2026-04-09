import { GoogleGenAI } from "@google/genai";
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs, 
  doc, 
  setDoc, 
  updateDoc, 
  deleteDoc,
  serverTimestamp,
  Timestamp,
  getDocFromServer
} from "firebase/firestore";
import { db, auth } from "./firebase";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import louvain from "graphology-communities-louvain";

// Initialize Gemini
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export enum Actor {
  USER = "user",
  AGENT = "agent",
  SYSTEM = "system"
}

export interface EpisodicMemory {
  interactionId?: string;
  sessionId: string;
  timestamp: string;
  actor: Actor;
  rawText: string;
}

export interface GraphNode {
  nodeId: string;
  type: "episodic" | "semantic";
  content: string;
  embedding: number[];
  metadata?: any;
  pageRank?: number;
  communityId?: string;
}

export interface SemanticFact {
  knowledgeId: string;
  distilledFact: string;
  embedding: number[];
  lastAccessed: string;
  provenance?: string[];
}

// Error handling helper as per instructions
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export class MemoryService {
  private static async getEmbedding(text: string): Promise<number[]> {
    try {
      const model = "gemini-embedding-2-preview";
      const result = await genAI.models.embedContent({
        model,
        contents: [{ parts: [{ text }] }],
      });
      return result.embeddings[0].values;
    } catch (error) {
      console.error("Embedding error:", error);
      return new Array(768).fill(0); // Fallback
    }
  }

  // STM: Short-Term Memory
  static async addEpisodicLog(sessionId: string, actor: Actor, rawText: string) {
    const path = "stm";
    try {
      const log: EpisodicMemory = {
        sessionId,
        actor,
        rawText,
        timestamp: new Date().toISOString()
      };
      const docRef = await addDoc(collection(db, path), log);
      return docRef.id;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  static async getRecentContext(sessionId: string, limitCount: number = 10) {
    const path = "stm";
    try {
      const q = query(
        collection(db, path),
        where("sessionId", "==", sessionId),
        orderBy("timestamp", "desc"),
        limit(limitCount)
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map(doc => ({ ...doc.data(), interactionId: doc.id }) as unknown as EpisodicMemory).reverse();
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  }

  // MTM: Medium-Term Memory (Graph)
  static async consolidateToMTM(interactionId: string, content: string) {
    const path = "mtm";
    try {
      const embedding = await this.getEmbedding(content);
      const node: GraphNode = {
        nodeId: interactionId,
        type: "episodic",
        content,
        embedding,
        metadata: { consolidatedAt: new Date().toISOString() }
      };
      await setDoc(doc(db, path, interactionId), node);
      return interactionId;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }

  // Algorithmic Forgetting & Consolidation
  static async runSleepCycle() {
    const mtmPath = "mtm";
    const ltmPath = "ltm";
    try {
      // 1. Fetch all MTM nodes
      const snapshot = await getDocs(collection(db, mtmPath));
      const nodes = snapshot.docs.map(doc => doc.data() as GraphNode);
      
      if (nodes.length < 2) return;

      const graph = new Graph();
      nodes.forEach(node => {
        graph.addNode(node.nodeId, { ...node });
      });

      // 2. Build edges based on vector similarity (Cosine Similarity)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const sim = this.cosineSimilarity(nodes[i].embedding, nodes[j].embedding);
          if (sim > 0.85) {
            graph.addEdge(nodes[i].nodeId, nodes[j].nodeId, { weight: sim });
          }
        }
      }

      // 3. Synaptic Pruning (PageRank)
      const pagerankScores = pagerank(graph) as Record<string, number>;
      const scores = Object.values(pagerankScores);
      const threshold = this.calculatePercentile(scores, 25); // Prune bottom 25%

      const nodesToPrune: string[] = [];
      Object.entries(pagerankScores).forEach(([nodeId, score]) => {
        if (score < threshold) {
          nodesToPrune.push(nodeId);
        }
      });

      // 4. Louvain Community Detection for LTM Consolidation
      const communities = louvain(graph) as unknown as Record<string, number>;
      const communityGroups: Record<string, string[]> = {};
      Object.entries(communities).forEach(([nodeId, communityId]) => {
        if (!nodesToPrune.includes(nodeId)) {
          if (!communityGroups[communityId]) communityGroups[communityId] = [];
          communityGroups[communityId].push(nodeId);
        }
      });

      // 5. Distill Communities to LTM
      for (const [communityId, nodeIds] of Object.entries(communityGroups)) {
        if (nodeIds.length >= 3) { // Only consolidate dense communities
          const communityContent = nodeIds.map(id => graph.getNodeAttribute(id, 'content')).join("\n");
          const distilledFact = await this.distillContent(communityContent);
          const embedding = await this.getEmbedding(distilledFact);
          
          const fact: SemanticFact = {
            knowledgeId: `ltm_${Date.now()}_${communityId}`,
            distilledFact,
            embedding,
            lastAccessed: new Date().toISOString(),
            provenance: nodeIds
          };
          await setDoc(doc(db, ltmPath, fact.knowledgeId), fact);
        }
      }

      // 6. Execute Pruning
      for (const nodeId of nodesToPrune) {
        await deleteDoc(doc(db, mtmPath, nodeId));
      }

      return { pruned: nodesToPrune.length, consolidated: Object.keys(communityGroups).length };
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, "sleep-cycle");
    }
  }

  private static cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let mA = 0;
    let mB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      mA += a[i] * a[i];
      mB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(mA) * Math.sqrt(mB));
  }

  private static calculatePercentile(values: number[], percentile: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[index] || 0;
  }

  private static async distillContent(content: string): Promise<string> {
    try {
      const model = "gemini-3-flash-preview";
      const response = await genAI.models.generateContent({
        model,
        contents: `Synthesize the following episodic memories into a single, dense, generalized semantic fact. Strip away specific dates and verbatim quotes. Focus on the underlying truth or user preference.
        
        Memories:
        ${content}`,
      });
      return response.text || "No distillation possible";
    } catch (error) {
      console.error("Distillation error:", error);
      return "Error in distillation";
    }
  }

  // LTM: Long-Term Memory
  static async searchLTM(queryText: string, limitCount: number = 3) {
    const path = "ltm";
    try {
      const queryEmbedding = await this.getEmbedding(queryText);
      const snapshot = await getDocs(collection(db, path));
      const facts = snapshot.docs.map(doc => ({ ...doc.data(), knowledgeId: doc.id }) as unknown as SemanticFact);
      
      // Manual vector search (since Firestore doesn't have native vector search yet in this env)
      const scoredFacts = facts.map(fact => ({
        ...fact,
        score: this.cosineSimilarity(queryEmbedding, fact.embedding)
      }));

      return scoredFacts
        .sort((a, b) => b.score - a.score)
        .slice(0, limitCount);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  }

  // Connection test as per instructions
  static async testConnection() {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
    } catch (error) {
      if(error instanceof Error && error.message.includes('the client is offline')) {
        console.error("Please check your Firebase configuration. ");
      }
    }
  }
}
