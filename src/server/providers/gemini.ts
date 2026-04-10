import { GoogleGenAI } from "@google/genai";
import { EMBEDDING_DIMENSIONS, normalizeEmbedding, zeroEmbedding } from "../embeddings.js";
import type { EmbeddingProvider } from "./types.js";

export class GeminiProvider implements EmbeddingProvider {
  private client: GoogleGenAI;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }

  async embed(text: string): Promise<number[]> {
    try {
      const result = await this.client.models.embedContent({
        model: "gemini-embedding-2-preview",
        contents: [{ parts: [{ text }] }],
        config: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
        },
      });
      return normalizeEmbedding(result.embeddings[0]?.values ?? []);
    } catch (error) {
      console.error("Gemini embedding error:", error);
      return zeroEmbedding();
    }
  }

  async generate(prompt: string): Promise<string> {
    try {
      const response = await this.client.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });
      return response.text || "";
    } catch (error) {
      console.error("Gemini generation error:", error);
      return "";
    }
  }
}
