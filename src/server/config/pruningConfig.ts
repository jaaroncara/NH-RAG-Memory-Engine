export interface PruningConfig {
  stmMaxAgeHours: number;
  stmMaxRowsPerSession: number;
  ltmDormancyDays: number;
  ltmSimilarityThreshold: number;
}

const DEFAULT_CONFIG: PruningConfig = {
  stmMaxAgeHours: 72,
  stmMaxRowsPerSession: 200,
  ltmDormancyDays: 60,
  ltmSimilarityThreshold: 0.88,
};

let currentConfig: PruningConfig = { ...DEFAULT_CONFIG };

export function getPruningConfig(): PruningConfig {
  return { ...currentConfig };
}

export function updatePruningConfig(updates: Partial<PruningConfig>): PruningConfig {
  currentConfig = { ...currentConfig, ...updates };
  return { ...currentConfig };
}

export function resetPruningConfig(): PruningConfig {
  currentConfig = { ...DEFAULT_CONFIG };
  return { ...currentConfig };
}
