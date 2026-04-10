import neo4j from "neo4j-driver";
import type { PoolClient, QueryResult } from "pg";

import { pool } from "../db/index.js";
import { getNeo4jDriver } from "../db/neo4j.js";

const MAX_QUERY_LENGTH = 20_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ROWS = 100;
const MAX_RESULT_ROWS = 250;

const SQL_READ_ONLY_STATEMENTS = new Set([
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "EXPLAIN",
  "VALUES",
]);

const SQL_DESTRUCTIVE_STATEMENTS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
  "GRANT",
  "REVOKE",
  "COMMENT",
  "VACUUM",
  "ANALYZE",
  "REFRESH",
  "SET",
  "RESET",
  "CALL",
  "COPY",
  "DO",
]);

const CYPHER_READ_ONLY_STATEMENTS = new Set([
  "MATCH",
  "OPTIONAL",
  "RETURN",
  "UNWIND",
  "WITH",
]);

const CYPHER_DESTRUCTIVE_KEYWORDS = [
  "CREATE",
  "MERGE",
  "DELETE",
  "DETACH DELETE",
  "SET",
  "REMOVE",
  "DROP",
];

export type QueryEngine = "sql" | "cypher";

export interface QueryInspectionResult {
  engine: QueryEngine;
  mode: "inspect";
  query: string;
  normalizedQuery: string;
  statementType: string;
  isReadOnly: boolean;
  isDestructive: boolean;
  warnings: string[];
  targets: string[];
  timeoutMs: number;
  maxRows: number;
}

export interface QueryExecutionResult extends Omit<QueryInspectionResult, "mode"> {
  mode: "execute";
  rowCount: number;
  executionTimeMs: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  summary: string;
  counters?: Record<string, number>;
}

interface QueryOptions {
  timeoutMs?: number;
  maxRows?: number;
}

export function inspectSqlQuery(queryText: string, options?: QueryOptions): QueryInspectionResult {
  const normalizedQuery = normalizeQuery(queryText, "sql");
  const sanitizedQuery = stripComments(normalizedQuery, "sql");
  const statementType = classifySqlStatement(sanitizedQuery);
  const isDestructive = isSqlDestructive(statementType, sanitizedQuery);
  const isReadOnly = !isDestructive && isSqlReadOnly(statementType, sanitizedQuery);

  return {
    engine: "sql",
    mode: "inspect",
    query: queryText,
    normalizedQuery,
    statementType,
    isReadOnly,
    isDestructive,
    warnings: buildSqlWarnings(sanitizedQuery, { isReadOnly, isDestructive }),
    targets: extractSqlTargets(sanitizedQuery),
    timeoutMs: normalizeTimeout(options?.timeoutMs),
    maxRows: normalizeMaxRows(options?.maxRows),
  };
}

export async function executeSqlQuery(queryText: string, options?: QueryOptions): Promise<QueryExecutionResult> {
  const inspection = inspectSqlQuery(queryText, options);
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout TO ${inspection.timeoutMs}`);

    const result = await client.query(inspection.normalizedQuery);
    await client.query("COMMIT");

    return buildSqlExecutionResult(inspection, result, Date.now() - startedAt);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export function inspectCypherQuery(queryText: string, options?: QueryOptions): QueryInspectionResult {
  const normalizedQuery = normalizeQuery(queryText, "cypher");
  const sanitizedQuery = stripComments(normalizedQuery, "cypher");
  const statementType = classifyCypherStatement(sanitizedQuery);
  const isDestructive = isCypherDestructive(statementType, sanitizedQuery);
  const isReadOnly = !isDestructive && CYPHER_READ_ONLY_STATEMENTS.has(statementType);

  return {
    engine: "cypher",
    mode: "inspect",
    query: queryText,
    normalizedQuery,
    statementType,
    isReadOnly,
    isDestructive,
    warnings: buildCypherWarnings(sanitizedQuery, { isReadOnly, isDestructive }),
    targets: extractCypherTargets(sanitizedQuery),
    timeoutMs: normalizeTimeout(options?.timeoutMs),
    maxRows: normalizeMaxRows(options?.maxRows),
  };
}

export async function executeCypherQuery(queryText: string, options?: QueryOptions): Promise<QueryExecutionResult> {
  const inspection = inspectCypherQuery(queryText, options);
  const driver = getNeo4jDriver();
  const session = driver.session();
  const startedAt = Date.now();

  try {
    const result = await session.run(inspection.normalizedQuery, {}, { timeout: inspection.timeoutMs });
    const rows = result.records.map((record) => serializeCypherRecord(record.toObject()));
    const truncated = rows.length > inspection.maxRows;
    const visibleRows = rows.slice(0, inspection.maxRows);
    const firstRow = visibleRows[0] ?? {};
    const columns = Object.keys(firstRow);
    const counters = normalizeCypherCounters(result.summary.counters.updates());

    return {
      ...inspection,
      mode: "execute",
      rowCount: rows.length,
      executionTimeMs: Date.now() - startedAt,
      columns,
      rows: visibleRows,
      truncated,
      summary: buildCypherSummary(inspection, rows.length, counters, truncated),
      counters,
    };
  } finally {
    await session.close();
  }
}

function normalizeQuery(queryText: string, engine: QueryEngine) {
  const trimmed = queryText.trim();
  if (!trimmed) {
    throw new Error("Query is required");
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds ${MAX_QUERY_LENGTH} characters`);
  }

  const normalized = trimmed.replace(/[;\s]+$/, "");
  if (!normalized) {
    throw new Error("Query is required");
  }

  assertSingleStatement(normalized, engine);
  return normalized;
}

function normalizeTimeout(value?: number) {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.floor(value), 250), MAX_TIMEOUT_MS);
}

function normalizeMaxRows(value?: number) {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_MAX_ROWS;
  }

  return Math.min(Math.max(Math.floor(value), 1), MAX_RESULT_ROWS);
}

function stripComments(query: string, engine: QueryEngine) {
  const lineCommentPattern = engine === "sql" ? /--.*$/gm : /\/\/.*$/gm;

  return query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(lineCommentPattern, " ")
    .trim();
}

function assertSingleStatement(query: string, engine: QueryEngine) {
  const lineCommentPrefix = engine === "sql" ? "--" : "//";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBlockComment = false;
  let inLineComment = false;

  for (let index = 0; index < query.length; index += 1) {
    const current = query[index];
    const next = query[index + 1] ?? "";

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (current === "/" && next === "*") {
        inBlockComment = true;
        index += 1;
        continue;
      }

      if (`${current}${next}` === lineCommentPrefix) {
        inLineComment = true;
        index += 1;
        continue;
      }
    }

    if (inSingleQuote) {
      if (current === "'" && next === "'") {
        index += 1;
        continue;
      }

      if (current === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (current === '"' && next === '"') {
        index += 1;
        continue;
      }

      if (current === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inBacktick) {
      if (current === "`") {
        inBacktick = false;
      }
      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
      continue;
    }

    if (current === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (current === "`") {
      inBacktick = true;
      continue;
    }

    if (current === ";") {
      throw new Error("Only a single statement may be executed at a time");
    }
  }
}

function classifySqlStatement(query: string) {
  const firstToken = query.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (firstToken === "WITH") {
    if (/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(query)) {
      return "WITH_WRITE";
    }
    return "WITH";
  }

  return firstToken ?? "UNKNOWN";
}

function isSqlDestructive(statementType: string, query: string) {
  if (statementType === "WITH_WRITE") {
    return true;
  }

  if (SQL_DESTRUCTIVE_STATEMENTS.has(statementType)) {
    return true;
  }

  if (statementType === "EXPLAIN" && /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(query)) {
    return true;
  }

  return false;
}

function isSqlReadOnly(statementType: string, query: string) {
  if (statementType === "WITH") {
    return !/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(query);
  }

  return SQL_READ_ONLY_STATEMENTS.has(statementType);
}

function buildSqlWarnings(query: string, flags: { isReadOnly: boolean; isDestructive: boolean }) {
  const warnings: string[] = [];

  if (flags.isDestructive) {
    warnings.push("This SQL statement can modify or remove relational data.");
  }

  if (flags.isReadOnly && !/\bLIMIT\b/i.test(query)) {
    warnings.push("Consider adding LIMIT to reduce large result sets.");
  }

  if (/\b(DROP|TRUNCATE)\b/i.test(query)) {
    warnings.push("Schema-level or bulk-destructive statements are irreversible from this console.");
  }

  return warnings;
}

function extractSqlTargets(query: string) {
  const targets = new Set<string>();
  const patterns = [
    /\bFROM\s+([A-Za-z0-9_."]+)/gi,
    /\bJOIN\s+([A-Za-z0-9_."]+)/gi,
    /\bUPDATE\s+([A-Za-z0-9_."]+)/gi,
    /\bINTO\s+([A-Za-z0-9_."]+)/gi,
    /\bTRUNCATE\s+(?:TABLE\s+)?([A-Za-z0-9_."]+)/gi,
    /\bALTER\s+TABLE\s+([A-Za-z0-9_."]+)/gi,
    /\bDROP\s+TABLE\s+([A-Za-z0-9_."]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of query.matchAll(pattern)) {
      const target = match[1]?.replace(/^"|"$/g, "");
      if (target) {
        targets.add(target);
      }
    }
  }

  return Array.from(targets);
}

function buildSqlExecutionResult(
  inspection: QueryInspectionResult,
  result: QueryResult<Record<string, unknown>>,
  executionTimeMs: number
): QueryExecutionResult {
  const truncated = result.rows.length > inspection.maxRows;
  const visibleRows = result.rows.slice(0, inspection.maxRows);

  return {
    ...inspection,
    mode: "execute",
    rowCount: result.rowCount ?? visibleRows.length,
    executionTimeMs,
    columns: result.fields.map((field) => field.name),
    rows: visibleRows,
    truncated,
    summary: inspection.isReadOnly
      ? `Returned ${result.rows.length} row(s)` + (truncated ? `, showing first ${inspection.maxRows}` : "")
      : `${result.command} affected ${result.rowCount ?? 0} row(s)`,
  };
}

function classifyCypherStatement(query: string) {
  const firstToken = query.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (!firstToken) {
    return "UNKNOWN";
  }

  if (firstToken === "OPTIONAL" && /^OPTIONAL\s+MATCH/i.test(query)) {
    return "OPTIONAL";
  }

  return firstToken;
}

function isCypherDestructive(statementType: string, query: string) {
  if (["CREATE", "MERGE", "DELETE", "SET", "REMOVE", "DROP"].includes(statementType)) {
    return true;
  }

  return CYPHER_DESTRUCTIVE_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, "i").test(query));
}

function buildCypherWarnings(query: string, flags: { isReadOnly: boolean; isDestructive: boolean }) {
  const warnings: string[] = [];

  if (flags.isDestructive) {
    warnings.push("This Cypher statement can modify or remove graph data.");
  }

  if (flags.isReadOnly && !/\bLIMIT\b/i.test(query)) {
    warnings.push("Consider adding LIMIT to reduce large result sets.");
  }

  if (/\bDETACH\s+DELETE\b/i.test(query)) {
    warnings.push("DETACH DELETE removes relationships together with matching nodes.");
  }

  return warnings;
}

function extractCypherTargets(query: string) {
  const targets = new Set<string>();

  for (const match of query.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1]) {
      targets.add(match[1]);
    }
  }

  return Array.from(targets);
}

function serializeCypherRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, serializeCypherValue(value)])
  );
}

function serializeCypherValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (neo4j.isInt(value)) {
    return value.inSafeRange() ? value.toNumber() : value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeCypherValue(item));
  }

  if (value instanceof neo4j.types.Node) {
    const node = value as InstanceType<typeof neo4j.types.Node>;
    return {
      kind: "node",
      elementId: node.elementId,
      labels: node.labels,
      properties: serializeCypherValue(node.properties),
    };
  }

  if (value instanceof neo4j.types.Relationship) {
    const relationship = value as InstanceType<typeof neo4j.types.Relationship>;
    return {
      kind: "relationship",
      elementId: relationship.elementId,
      type: relationship.type,
      startNodeElementId: relationship.startNodeElementId,
      endNodeElementId: relationship.endNodeElementId,
      properties: serializeCypherValue(relationship.properties),
    };
  }

  if (value instanceof neo4j.types.Path) {
    const path = value as InstanceType<typeof neo4j.types.Path>;
    return {
      kind: "path",
      length: path.length,
      start: serializeCypherValue(path.start),
      end: serializeCypherValue(path.end),
      segments: path.segments.map((segment) => ({
        start: serializeCypherValue(segment.start),
        relationship: serializeCypherValue(segment.relationship),
        end: serializeCypherValue(segment.end),
      })),
    };
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeCypherValue(entry)])
    );
  }

  return value;
}

function normalizeCypherCounters(counters: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(counters)
      .filter(([, value]) => Number(value) !== 0)
      .map(([key, value]) => [key, Number(value)])
  );
}

function buildCypherSummary(
  inspection: QueryInspectionResult,
  rowCount: number,
  counters: Record<string, number>,
  truncated: boolean
) {
  if (inspection.isReadOnly) {
    return `Returned ${rowCount} record(s)` + (truncated ? `, showing first ${inspection.maxRows}` : "");
  }

  const updates = Object.entries(counters)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");

  return updates ? `Graph updated (${updates})` : "Cypher statement executed";
}

async function rollbackQuietly(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Ignore rollback failures after an already failed statement.
  }
}