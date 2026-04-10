import OpenAI from "openai";
import { EMBEDDING_DIMENSIONS, normalizeEmbedding, zeroEmbedding } from "../embeddings.js";
import type { EmbeddingProvider } from "./types.js";

export class OpenAIProvider implements EmbeddingProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
      });
      return normalizeEmbedding(response.data[0]?.embedding ?? []);
    } catch (error) {
      console.error("OpenAI embedding error:", error);
      return zeroEmbedding();
    }
  }

  async generate(prompt: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });
      return response.choices[0]?.message?.content || "";
    } catch (error) {
      console.error("OpenAI generation error:", error);
      return "";
    }
  }
}
