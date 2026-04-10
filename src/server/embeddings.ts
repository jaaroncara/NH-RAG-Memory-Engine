export const EMBEDDING_DIMENSIONS = 768;

export function normalizeEmbedding(values: number[]): number[] {
  if (values.length === EMBEDDING_DIMENSIONS) {
    return values;
  }

  if (values.length > EMBEDDING_DIMENSIONS) {
    return values.slice(0, EMBEDDING_DIMENSIONS);
  }

  return values.concat(new Array(EMBEDDING_DIMENSIONS - values.length).fill(0));
}

export function zeroEmbedding(): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(0);
}
