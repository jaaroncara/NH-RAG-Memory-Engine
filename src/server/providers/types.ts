export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  generate(prompt: string): Promise<string>;
}
