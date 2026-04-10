import { z } from "zod";

import { getProvider } from "../providers/index.js";

const semanticEntityTypeSchema = z.enum([
  "person",
  "location",
  "project",
  "tool",
  "topic",
]);

const rawExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        entityType: semanticEntityTypeSchema,
        canonicalName: z.string().trim().min(1).max(120),
        aliases: z.array(z.string().trim().min(1).max(120)).max(8).optional().default([]),
        relationshipType: z.string().trim().min(1).max(64).optional().nullable(),
        relationshipHint: z.string().trim().min(1).max(180).optional().nullable(),
        confidence: z.number().min(0).max(1).optional().default(0.7),
        evidence: z.string().trim().min(1).max(240).optional().nullable(),
      })
    )
    .max(16)
    .default([]),
});

export type SemanticEntityType = z.infer<typeof semanticEntityTypeSchema>;

export const SEMANTIC_RELATIONSHIP_TYPES = [
  "MENTIONS_PERSON",
  "MENTIONS_LOCATION",
  "LOCATED_IN",
  "REFERENCES_PROJECT",
  "WORKS_ON_PROJECT",
  "USES_TOOL",
  "MENTIONS_TOOL",
  "HAS_TOPIC",
  "MENTIONS_TOPIC",
  "RELATED_TO_ENTITY",
] as const;

export type SemanticRelationshipType = (typeof SEMANTIC_RELATIONSHIP_TYPES)[number];

export interface ExtractedEntity {
  entityId: string;
  entityType: SemanticEntityType;
  canonicalName: string;
  canonicalKey: string;
  aliases: string[];
  relationshipType: SemanticRelationshipType;
  relationshipHint: string | null;
  rawRelationshipType: string | null;
  confidence: number;
  evidence: string | null;
}

const allowedRelationshipTypes: Record<SemanticEntityType, readonly SemanticRelationshipType[]> = {
  person: ["MENTIONS_PERSON"],
  location: ["MENTIONS_LOCATION", "LOCATED_IN"],
  project: ["REFERENCES_PROJECT", "WORKS_ON_PROJECT"],
  tool: ["USES_TOOL", "MENTIONS_TOOL"],
  topic: ["HAS_TOPIC", "MENTIONS_TOPIC"],
};

const defaultRelationshipTypes: Record<SemanticEntityType, SemanticRelationshipType> = {
  person: "MENTIONS_PERSON",
  location: "MENTIONS_LOCATION",
  project: "REFERENCES_PROJECT",
  tool: "USES_TOOL",
  topic: "HAS_TOPIC",
};

const relationshipSpecificity: Record<SemanticRelationshipType, number> = {
  RELATED_TO_ENTITY: 0,
  MENTIONS_PERSON: 1,
  MENTIONS_LOCATION: 1,
  REFERENCES_PROJECT: 1,
  MENTIONS_TOOL: 1,
  MENTIONS_TOPIC: 1,
  LOCATED_IN: 2,
  WORKS_ON_PROJECT: 2,
  USES_TOOL: 2,
  HAS_TOPIC: 2,
};

export async function extractSemanticEntities(content: string): Promise<ExtractedEntity[]> {
  const normalizedContent = content.trim();
  if (normalizedContent.length < 3) {
    return [];
  }

  const provider = getProvider();
  const response = await provider.generate(buildExtractionPrompt(normalizedContent));
  const parsed = parseExtractionResponse(response);

  if (!parsed) {
    return [];
  }

  return deduplicateEntities(
    parsed.entities.map((entity) => {
      const canonicalName = normalizeDisplayText(entity.canonicalName);
      const canonicalKey = buildCanonicalKey(canonicalName);
      const aliases = buildAliasList(canonicalName, entity.aliases);
      const relationshipType = resolveRelationshipType(entity.entityType, entity.relationshipType);

      return {
        entityId: `${entity.entityType}:${canonicalKey}`,
        entityType: entity.entityType,
        canonicalName,
        canonicalKey,
        aliases,
        relationshipType,
        relationshipHint: normalizeOptionalText(entity.relationshipHint),
        rawRelationshipType: normalizeOptionalText(entity.relationshipType),
        confidence: entity.confidence ?? 0.7,
        evidence: normalizeOptionalText(entity.evidence),
      } satisfies ExtractedEntity;
    })
  );
}

function buildExtractionPrompt(content: string) {
  return [
    "Extract only durable semantic entities from the episodic memory below.",
    "Return JSON only with this exact shape:",
    '{"entities":[{"entityType":"person|location|project|tool|topic","canonicalName":"...","aliases":["..."],"relationshipType":"...","relationshipHint":"...","confidence":0.0,"evidence":"..."}]}',
    "Rules:",
    "- Only include entities explicitly present in the text.",
    "- Ignore pronouns, vague references, stop words, and low-value transient details.",
    "- relationshipType must be one of: MENTIONS_PERSON, MENTIONS_LOCATION, LOCATED_IN, REFERENCES_PROJECT, WORKS_ON_PROJECT, USES_TOOL, MENTIONS_TOOL, HAS_TOPIC, MENTIONS_TOPIC.",
    "- Use the most canonical short name possible for canonicalName.",
    "- aliases should contain only distinct useful variants that appear in the text.",
    "- confidence must be between 0 and 1.",
    "- If no durable entities exist, return {\"entities\":[]}",
    "Episodic memory:",
    content,
  ].join("\n");
}

function parseExtractionResponse(response: string) {
  const payload = extractJsonPayload(response);
  if (!payload) {
    return null;
  }

  try {
    return rawExtractionSchema.parse(JSON.parse(payload));
  } catch {
    return null;
  }
}

function extractJsonPayload(response: string) {
  const trimmed = response.trim();
  if (!trimmed) {
    return null;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return trimmed.slice(start, end + 1);
}

function deduplicateEntities(entities: ExtractedEntity[]) {
  const merged = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    if (!entity.canonicalKey) {
      continue;
    }

    const existing = merged.get(entity.entityId);
    if (!existing) {
      merged.set(entity.entityId, entity);
      continue;
    }

    const nextRelationship =
      relationshipSpecificity[entity.relationshipType] > relationshipSpecificity[existing.relationshipType]
        ? entity.relationshipType
        : existing.relationshipType;

    merged.set(entity.entityId, {
      ...existing,
      canonicalName: existing.canonicalName.length >= entity.canonicalName.length ? existing.canonicalName : entity.canonicalName,
      aliases: Array.from(new Set([...existing.aliases, ...entity.aliases])),
      relationshipType: nextRelationship,
      relationshipHint: existing.relationshipHint ?? entity.relationshipHint,
      rawRelationshipType: existing.rawRelationshipType ?? entity.rawRelationshipType,
      confidence: Math.max(existing.confidence, entity.confidence),
      evidence: existing.evidence ?? entity.evidence,
    });
  }

  return Array.from(merged.values());
}

function resolveRelationshipType(entityType: SemanticEntityType, candidate: string | null | undefined): SemanticRelationshipType {
  const normalizedCandidate = normalizeRelationshipToken(candidate);
  if (!normalizedCandidate) {
    return defaultRelationshipTypes[entityType];
  }

  const allowed = allowedRelationshipTypes[entityType];
  return allowed.includes(normalizedCandidate) ? normalizedCandidate : "RELATED_TO_ENTITY";
}

function normalizeRelationshipToken(value: string | null | undefined): SemanticRelationshipType | null {
  const normalized = normalizeOptionalText(value)
    ?.replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  if (!normalized) {
    return null;
  }

  return SEMANTIC_RELATIONSHIP_TYPES.includes(normalized as SemanticRelationshipType)
    ? (normalized as SemanticRelationshipType)
    : null;
}

function buildAliasList(canonicalName: string, aliases: string[]) {
  return Array.from(
    new Set(
      [canonicalName, ...aliases.map((alias) => normalizeDisplayText(alias))]
        .map((alias) => alias.trim())
        .filter(Boolean)
    )
  );
}

function normalizeDisplayText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function buildCanonicalKey(value: string) {
  return normalizeDisplayText(value)
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}