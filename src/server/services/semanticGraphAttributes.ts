import {
  type ExtractedEntity,
  type SemanticEntityType,
  type SemanticRelationshipType,
} from "./entityExtractionService.js";

export interface StoredSemanticEntity {
  entityId: string;
  entityType: SemanticEntityType;
  canonicalName: string;
  aliases: string[];
  relationshipType: SemanticRelationshipType;
  relationshipHint: string | null;
  confidence: number;
  evidence: string | null;
  mentionCount: number;
}

export interface SharedSemanticEntity {
  entityId: string;
  entityType: SemanticEntityType;
  canonicalName: string;
  confidence: number;
  relationshipTypes: SemanticRelationshipType[];
  relationshipHints: string[];
}

export interface SemanticNodeProperties {
  semanticEntityCount: number;
  semanticEntityKeys: string[];
  semanticEntityNames: string[];
  semanticEntityTypes: SemanticEntityType[];
  semanticRelationshipTypes: SemanticRelationshipType[];
  semanticMaxConfidence: number;
  semanticPayloadJson: string;
  semanticEntities: StoredSemanticEntity[];
}

export interface SemanticEdgeProperties {
  weight: number;
  cosineWeight: number;
  semanticOverlapWeight: number;
  combinedWeight: number;
  sharedEntityCount: number;
  sharedEntityKeys: string[];
  sharedEntityNames: string[];
  sharedEntityTypes: SemanticEntityType[];
  semanticOverlapJson: string;
  sharedEntities: SharedSemanticEntity[];
}

export const COSINE_WEIGHT_RATIO = 0.8;
export const SEMANTIC_WEIGHT_RATIO = 0.2;

export function buildSemanticNodeProperties(entities: ExtractedEntity[]): SemanticNodeProperties {
  const normalizedEntities = normalizeStoredSemanticEntities(
    entities.map((entity) => ({
      entityId: entity.entityId,
      entityType: entity.entityType,
      canonicalName: entity.canonicalName,
      aliases: entity.aliases,
      relationshipType: entity.relationshipType,
      relationshipHint: entity.relationshipHint,
      confidence: entity.confidence,
      evidence: entity.evidence,
      mentionCount: 1,
    }))
  );

  return buildSemanticNodePropertiesFromStored(normalizedEntities);
}

export function buildSemanticNodePropertiesFromStored(
  entities: StoredSemanticEntity[]
): SemanticNodeProperties {
  const normalizedEntities = normalizeStoredSemanticEntities(entities);

  return {
    semanticEntityCount: normalizedEntities.length,
    semanticEntityKeys: normalizedEntities.map((entity) => entity.entityId),
    semanticEntityNames: normalizedEntities.map((entity) => entity.canonicalName),
    semanticEntityTypes: uniqueValues(normalizedEntities.map((entity) => entity.entityType)),
    semanticRelationshipTypes: uniqueValues(
      normalizedEntities.map((entity) => entity.relationshipType)
    ),
    semanticMaxConfidence: normalizedEntities.reduce(
      (highest, entity) => Math.max(highest, entity.confidence),
      0
    ),
    semanticPayloadJson: JSON.stringify(normalizedEntities),
    semanticEntities: normalizedEntities,
  };
}

export function parseStoredSemanticEntities(raw: unknown): StoredSemanticEntity[] {
  if (typeof raw !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeStoredSemanticEntities(
      parsed
        .map((value) => parseStoredSemanticEntity(value))
        .filter((value): value is StoredSemanticEntity => value !== null)
    );
  } catch {
    return [];
  }
}

export function buildSemanticEdgeProperties(
  sourceEntities: StoredSemanticEntity[],
  targetEntities: StoredSemanticEntity[],
  cosineWeight: number
): SemanticEdgeProperties {
  const normalizedSource = normalizeStoredSemanticEntities(sourceEntities);
  const normalizedTarget = normalizeStoredSemanticEntities(targetEntities);
  const sourceById = new Map(normalizedSource.map((entity) => [entity.entityId, entity]));
  const targetById = new Map(normalizedTarget.map((entity) => [entity.entityId, entity]));
  const sourceExpanded = buildAliasExpandedKeys(normalizedSource);
  const targetExpanded = buildAliasExpandedKeys(normalizedTarget);
  const sharedSourceIds = new Set<string>();
  for (const [aliasKey, sourceCanonicalId] of sourceExpanded) {
    if (targetExpanded.has(aliasKey)) {
      sharedSourceIds.add(sourceCanonicalId);
    }
  }
  const sharedKeys = Array.from(sharedSourceIds).sort();
  const unionKeys = new Set([...sourceById.keys(), ...targetById.keys()]);
  const semanticOverlapWeight = unionKeys.size === 0 ? 0 : sharedKeys.length / unionKeys.size;
  const combinedWeight =
    cosineWeight * COSINE_WEIGHT_RATIO + semanticOverlapWeight * SEMANTIC_WEIGHT_RATIO;
  const sharedEntities = sharedKeys.map((sourceId) => {
    const left = sourceById.get(sourceId)!;

    // Exact match: source canonical key exists directly in target
    if (targetById.has(sourceId)) {
      const right = targetById.get(sourceId)!;
      return {
        entityId: sourceId,
        entityType: left.entityType,
        canonicalName:
          left.canonicalName.length >= right.canonicalName.length
            ? left.canonicalName
            : right.canonicalName,
        confidence: Math.max(left.confidence, right.confidence),
        relationshipTypes: uniqueValues([left.relationshipType, right.relationshipType]),
        relationshipHints: uniqueValues(
          [left.relationshipHint, right.relationshipHint].filter(
            (value): value is string => Boolean(value)
          )
        ),
      } satisfies SharedSemanticEntity;
    }

    // Alias-only match: find the target entity via alias key resolution
    let right: StoredSemanticEntity | undefined;
    for (const [aliasKey, canonicalId] of sourceExpanded) {
      if (canonicalId === sourceId && targetExpanded.has(aliasKey)) {
        right = targetById.get(targetExpanded.get(aliasKey)!);
        if (right) break;
      }
    }

    const effectiveRight = right ?? left;
    return {
      entityId: sourceId,
      entityType: left.entityType,
      canonicalName:
        left.canonicalName.length >= effectiveRight.canonicalName.length
          ? left.canonicalName
          : effectiveRight.canonicalName,
      confidence: Math.max(left.confidence, effectiveRight.confidence),
      relationshipTypes: right
        ? uniqueValues([left.relationshipType, right.relationshipType])
        : [left.relationshipType],
      relationshipHints: uniqueValues(
        [left.relationshipHint, right?.relationshipHint ?? null].filter(
          (value): value is string => Boolean(value)
        )
      ),
    } satisfies SharedSemanticEntity;
  });

  return {
    weight: combinedWeight,
    cosineWeight,
    semanticOverlapWeight,
    combinedWeight,
    sharedEntityCount: sharedEntities.length,
    sharedEntityKeys: sharedEntities.map((entity) => entity.entityId),
    sharedEntityNames: sharedEntities.map((entity) => entity.canonicalName),
    sharedEntityTypes: uniqueValues(sharedEntities.map((entity) => entity.entityType)),
    semanticOverlapJson: JSON.stringify(sharedEntities),
    sharedEntities,
  };
}

export function parseSharedSemanticEntities(raw: unknown): SharedSemanticEntity[] {
  if (typeof raw !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => parseSharedSemanticEntity(value))
      .filter((value): value is SharedSemanticEntity => value !== null);
  } catch {
    return [];
  }
}

function parseStoredSemanticEntity(value: unknown): StoredSemanticEntity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const entityId = asString(candidate.entityId);
  const canonicalName = asString(candidate.canonicalName);
  const entityType = asSemanticEntityType(candidate.entityType);
  const relationshipType = asSemanticRelationshipType(candidate.relationshipType);
  if (!entityId || !canonicalName || !entityType || !relationshipType) {
    return null;
  }

  return {
    entityId,
    entityType,
    canonicalName,
    aliases: asStringArray(candidate.aliases),
    relationshipType,
    relationshipHint: asOptionalString(candidate.relationshipHint),
    confidence: asNumber(candidate.confidence, 0),
    evidence: asOptionalString(candidate.evidence),
    mentionCount: Math.max(1, Math.floor(asNumber(candidate.mentionCount, 1))),
  };
}

function parseSharedSemanticEntity(value: unknown): SharedSemanticEntity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const entityId = asString(candidate.entityId);
  const canonicalName = asString(candidate.canonicalName);
  const entityType = asSemanticEntityType(candidate.entityType);
  if (!entityId || !canonicalName || !entityType) {
    return null;
  }

  return {
    entityId,
    entityType,
    canonicalName,
    confidence: asNumber(candidate.confidence, 0),
    relationshipTypes: asSemanticRelationshipArray(candidate.relationshipTypes),
    relationshipHints: asStringArray(candidate.relationshipHints),
  };
}

function normalizeStoredSemanticEntities(entities: StoredSemanticEntity[]): StoredSemanticEntity[] {
  const merged = new Map<string, StoredSemanticEntity>();

  for (const entity of entities) {
    const existing = merged.get(entity.entityId);
    if (!existing) {
      merged.set(entity.entityId, {
        ...entity,
        aliases: uniqueValues(entity.aliases),
      });
      continue;
    }

    merged.set(entity.entityId, {
      ...existing,
      canonicalName:
        existing.canonicalName.length >= entity.canonicalName.length
          ? existing.canonicalName
          : entity.canonicalName,
      aliases: uniqueValues([...existing.aliases, ...entity.aliases]),
      confidence: Math.max(existing.confidence, entity.confidence),
      relationshipHint: existing.relationshipHint ?? entity.relationshipHint,
      evidence: existing.evidence ?? entity.evidence,
      mentionCount: Math.max(existing.mentionCount, entity.mentionCount),
    });
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.canonicalName.localeCompare(right.canonicalName)
  );
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function asOptionalString(value: unknown) {
  const next = asString(value);
  return next.length > 0 ? next : null;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? uniqueValues(
      value
        .map((entry) => asString(entry))
        .filter((entry) => entry.length > 0)
    )
    : [];
}

function asNumber(value: unknown, fallback: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function asSemanticEntityType(value: unknown): SemanticEntityType | null {
  return value === "person" ||
    value === "location" ||
    value === "project" ||
    value === "tool" ||
    value === "topic"
    ? value
    : null;
}

function asSemanticRelationshipType(value: unknown): SemanticRelationshipType | null {
  return value === "MENTIONS_PERSON" ||
    value === "MENTIONS_LOCATION" ||
    value === "LOCATED_IN" ||
    value === "REFERENCES_PROJECT" ||
    value === "WORKS_ON_PROJECT" ||
    value === "USES_TOOL" ||
    value === "MENTIONS_TOOL" ||
    value === "HAS_TOPIC" ||
    value === "MENTIONS_TOPIC" ||
    value === "RELATED_TO_ENTITY"
    ? value
    : null;
}

function asSemanticRelationshipArray(value: unknown) {
  return Array.isArray(value)
    ? uniqueValues(
      value
        .map((entry) => asSemanticRelationshipType(entry))
        .filter((entry): entry is SemanticRelationshipType => entry !== null)
    )
    : [];
}

function uniqueValues<T>(values: T[]) {
  return Array.from(new Set(values));
}

function buildAliasExpandedKeys(entities: StoredSemanticEntity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entity of entities) {
    map.set(entity.entityId, entity.entityId);
    for (const alias of entity.aliases) {
      map.set(`${entity.entityType}:${buildCanonicalKey(alias)}`, entity.entityId);
    }
  }
  return map;
}

function normalizeDisplayText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function buildCanonicalKey(value: string): string {
  return normalizeDisplayText(value)
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}