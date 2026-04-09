import type { EmbeddingProvider } from "./types.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";

let instance: EmbeddingProvider | null = null;

export function getProvider(): EmbeddingProvider {
  if (!instance) {
    const name = (process.env.EMBEDDING_PROVIDER || "gemini").toLowerCase();
    switch (name) {
      case "openai":
        instance = new OpenAIProvider();
        break;
      case "gemini":
      default:
        instance = new GeminiProvider();
        break;
    }
    console.log(`Embedding provider: ${name}`);
  }
  return instance;
}

export type { EmbeddingProvider } from "./types.js";
