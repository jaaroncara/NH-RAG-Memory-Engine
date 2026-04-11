import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { cn } from "../../lib/utils";
import {
  MemoryService,
  type ClearKnowledgeBasesResult,
  type QueryEngine,
  type QueryExecutionResult,
  type QueryInspectionResult,
} from "../lib/memoryService";
import {
  CLEAR_ALL_CYPHER_SNIPPET,
  CLEAR_ALL_SQL_SNIPPET,
  KNOWLEDGE_BASE_CLEAR_CONFIRMATION,
} from "../shared/knowledgeBaseReset";

const HISTORY_STORAGE_KEY = "nhrag.query-console.history";
const HISTORY_LIMIT = 24;

const DEFAULT_QUERIES: Record<QueryEngine, string> = {
  sql: `SELECT document_id, filename, import_status, chunk_count\nFROM documents\nORDER BY created_at DESC\nLIMIT 20`,
  cypher: `MATCH (n:EpisodicNode)\nRETURN n.nodeId AS nodeId, n.content AS content, n.communityId AS communityId\nLIMIT 20`,
};

type ConsoleTab = QueryEngine | "history";

interface EngineState {
  query: string;
  inspection: QueryInspectionResult | null;
  result: QueryExecutionResult | null;
  isInspecting: boolean;
  isExecuting: boolean;
  confirmArmed: boolean;
}

interface QueryHistoryEntry {
  id: string;
  engine: QueryEngine;
  action: "inspect" | "execute";
  statementType: string;
  status: "success" | "error";
  summary: string;
  query: string;
  isDestructive: boolean;
  rowCount?: number;
  createdAt: string;
}

const initialEngineState = (engine: QueryEngine): EngineState => ({
  query: DEFAULT_QUERIES[engine],
  inspection: null,
  result: null,
  isInspecting: false,
  isExecuting: false,
  confirmArmed: false,
});

export default function QueryConsoleView({
  onDataMutation,
}: {
  onDataMutation?: () => Promise<void> | void;
}) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("sql");
  const [engines, setEngines] = useState<Record<QueryEngine, EngineState>>({
    sql: initialEngineState("sql"),
    cypher: initialEngineState("cypher"),
  });
  const [history, setHistory] = useState<QueryHistoryEntry[]>(loadHistory);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [clearResult, setClearResult] = useState<ClearKnowledgeBasesResult | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  const updateEngine = (engine: QueryEngine, patch: Partial<EngineState>) => {
    setEngines((current) => ({
      ...current,
      [engine]: {
        ...current[engine],
        ...patch,
      },
    }));
  };

  const runInspection = async (engine: QueryEngine, recordHistory: boolean) => {
    const query = engines[engine].query.trim();
    if (!query) {
      toast.error("Query is required");
      return null;
    }

    updateEngine(engine, { isInspecting: true, confirmArmed: false });

    try {
      const inspection =
        engine === "sql"
          ? await MemoryService.inspectSqlQuery(query)
          : await MemoryService.inspectCypherQuery(query);

      updateEngine(engine, {
        inspection,
        result: null,
        isInspecting: false,
        confirmArmed: false,
      });

      if (recordHistory) {
        recordHistoryEntry({
          engine,
          action: "inspect",
          statementType: inspection.statementType,
          status: "success",
          summary: inspection.isDestructive
            ? "Destructive query detected during preview"
            : "Query preview completed",
          query,
          isDestructive: inspection.isDestructive,
        });
      }

      return inspection;
    } catch (error) {
      updateEngine(engine, { isInspecting: false });
      const message = error instanceof Error ? error.message : "Query preview failed";
      toast.error(message);

      if (recordHistory) {
        recordHistoryEntry({
          engine,
          action: "inspect",
          statementType: "ERROR",
          status: "error",
          summary: message,
          query,
          isDestructive: false,
        });
      }

      return null;
    }
  };

  const executeQuery = async (engine: QueryEngine, confirmed = false) => {
    const query = engines[engine].query.trim();
    if (!query) {
      toast.error("Query is required");
      return;
    }

    let inspection = engines[engine].inspection;
    if (!inspection || inspection.query.trim() !== query) {
      inspection = await runInspection(engine, false);
      if (!inspection) {
        return;
      }
    }

    if (inspection.isDestructive && !confirmed) {
      updateEngine(engine, { inspection, confirmArmed: true });
      toast.error("Previewed query is destructive. Confirm execution to continue.");
      return;
    }

    updateEngine(engine, { isExecuting: true, confirmArmed: false });

    try {
      const result =
        engine === "sql"
          ? await MemoryService.executeSqlQuery(query)
          : await MemoryService.executeCypherQuery(query);

      updateEngine(engine, {
        inspection: toInspectionResult(result),
        result,
        isExecuting: false,
        confirmArmed: false,
      });

      recordHistoryEntry({
        engine,
        action: "execute",
        statementType: result.statementType,
        status: "success",
        summary: result.summary,
        query,
        isDestructive: result.isDestructive,
        rowCount: result.rowCount,
      });

      if (!result.isReadOnly) {
        await onDataMutation?.();
      }

      toast.success(result.summary);
    } catch (error) {
      updateEngine(engine, { isExecuting: false });
      const message = error instanceof Error ? error.message : "Query execution failed";
      toast.error(message);
      recordHistoryEntry({
        engine,
        action: "execute",
        statementType: inspection.statementType,
        status: "error",
        summary: message,
        query,
        isDestructive: inspection.isDestructive,
      });
    }
  };

  const resetEngine = (engine: QueryEngine) => {
    updateEngine(engine, {
      query: "",
      inspection: null,
      result: null,
      confirmArmed: false,
    });
  };

  const restoreFromHistory = (entry: QueryHistoryEntry) => {
    updateEngine(entry.engine, {
      query: entry.query,
      confirmArmed: false,
    });
    setActiveTab(entry.engine);
  };

  const clearHistory = () => {
    setHistory([]);
  };

  const handleClearAllKnowledgeBases = async () => {
    if (resetConfirmation.trim() !== KNOWLEDGE_BASE_CLEAR_CONFIRMATION) {
      toast.error(`Type ${KNOWLEDGE_BASE_CLEAR_CONFIRMATION} to enable the reset action.`);
      return;
    }

    setIsClearingAll(true);

    try {
      const result = await MemoryService.clearAllKnowledgeBases(resetConfirmation.trim());

      setClearResult(result);
      setResetConfirmation("");
      updateEngine("sql", {
        query: result.sqlQuery,
        inspection: toInspectionResult(result.sqlResult),
        result: result.sqlResult,
        confirmArmed: false,
      });
      updateEngine("cypher", {
        query: result.cypherQuery,
        inspection: toInspectionResult(result.cypherResult),
        result: result.cypherResult,
        confirmArmed: false,
      });

      recordHistoryEntry({
        engine: "cypher",
        action: "execute",
        statementType: result.cypherResult.statementType,
        status: "success",
        summary: "Cleared Neo4j knowledge graph from the Data Console danger zone",
        query: result.cypherQuery,
        isDestructive: true,
        rowCount: result.cypherResult.rowCount,
      });
      recordHistoryEntry({
        engine: "sql",
        action: "execute",
        statementType: result.sqlResult.statementType,
        status: "success",
        summary: "Cleared PostgreSQL knowledge stores from the Data Console danger zone",
        query: result.sqlQuery,
        isDestructive: true,
        rowCount: result.sqlResult.rowCount,
      });

      await onDataMutation?.();
      toast.success(result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Clear-all reset failed";
      toast.error(message);
    } finally {
      setIsClearingAll(false);
    }
  };

  const recordHistoryEntry = (entry: Omit<QueryHistoryEntry, "id" | "createdAt">) => {
    const nextEntry: QueryHistoryEntry = {
      ...entry,
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
    };

    setHistory((current) => [nextEntry, ...current].slice(0, HISTORY_LIMIT));
  };

  return (
    <div className="space-y-6">
      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>Data Console</CardTitle>
          <CardDescription className="text-neutral-400">
            Developer-facing SQL and Cypher console for selective inspection and mutation. Destructive statements require confirmation and history is limited to this browser session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ConsoleTab)}>
            <TabsList variant="line" className="mb-5 border-white/10 bg-transparent">
              <TabsTrigger value="sql">SQL</TabsTrigger>
              <TabsTrigger value="cypher">Cypher</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>

            <TabsContent value="sql">
              <EngineConsolePanel
                engine="sql"
                state={engines.sql}
                onQueryChange={(query) => updateEngine("sql", { query, inspection: null, result: null, confirmArmed: false })}
                onInspect={() => void runInspection("sql", true)}
                onExecute={() => void executeQuery("sql")}
                onConfirmExecute={() => void executeQuery("sql", true)}
                onReset={() => resetEngine("sql")}
              />
            </TabsContent>

            <TabsContent value="cypher">
              <EngineConsolePanel
                engine="cypher"
                state={engines.cypher}
                onQueryChange={(query) => updateEngine("cypher", { query, inspection: null, result: null, confirmArmed: false })}
                onInspect={() => void runInspection("cypher", true)}
                onExecute={() => void executeQuery("cypher")}
                onConfirmExecute={() => void executeQuery("cypher", true)}
                onReset={() => resetEngine("cypher")}
              />
            </TabsContent>

            <TabsContent value="history">
              <HistoryPanel history={history} onRestore={restoreFromHistory} onClear={clearHistory} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <KnowledgeBaseResetPanel
        confirmation={resetConfirmation}
        onConfirmationChange={setResetConfirmation}
        onClearAll={() => void handleClearAllKnowledgeBases()}
        isClearingAll={isClearingAll}
        isQueryPending={engines.sql.isInspecting || engines.sql.isExecuting || engines.cypher.isInspecting || engines.cypher.isExecuting}
        lastResult={clearResult}
      />
    </div>
  );
}

function KnowledgeBaseResetPanel({
  confirmation,
  onConfirmationChange,
  onClearAll,
  isClearingAll,
  isQueryPending,
  lastResult,
}: {
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  onClearAll: () => void;
  isClearingAll: boolean;
  isQueryPending: boolean;
  lastResult: ClearKnowledgeBasesResult | null;
}) {
  const isConfirmed = confirmation.trim() === KNOWLEDGE_BASE_CLEAR_CONFIRMATION;

  return (
    <Card className="border-rose-500/18 bg-white/[0.03] text-neutral-100 shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-rose-200/90 text-rose-950">Danger Zone</Badge>
          <Badge className="bg-white/10 text-neutral-100">Irreversible</Badge>
          <Badge className="bg-white/10 text-neutral-100">Schema Preserved</Badge>
        </div>
        <CardTitle className="mt-3 text-rose-100">Clear all knowledge bases</CardTitle>
        <CardDescription className="text-neutral-400">
          This removes all STM, documents, chunks, jobs, pipeline events, LTM facts, and the full Neo4j MTM graph while preserving tables, indexes, constraints, extensions, and graph schema.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="rounded-[16px] border border-rose-500/16 bg-rose-500/[0.05] p-4">
              <p className="text-sm leading-6 text-neutral-200">
                Use this only when you intend to reset every knowledge store. The action cannot be undone from the console.
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <SnippetPanel title="SQL reset snippet" code={CLEAR_ALL_SQL_SNIPPET} />
              <SnippetPanel title="Cypher reset snippet" code={CLEAR_ALL_CYPHER_SNIPPET} />
            </div>

            <div className="rounded-[16px] border border-rose-500/20 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.24em] text-rose-200/70">Confirmation</p>
              <p className="mt-2 text-sm text-neutral-300">
                Type {KNOWLEDGE_BASE_CLEAR_CONFIRMATION} to enable the reset button.
              </p>
              <div className="mt-3 flex flex-col gap-3 md:flex-row">
                <Input
                  value={confirmation}
                  onChange={(event) => onConfirmationChange(event.target.value)}
                  placeholder={KNOWLEDGE_BASE_CLEAR_CONFIRMATION}
                  className="border-rose-500/18 bg-black/25 text-neutral-100 placeholder:text-neutral-500 focus-visible:border-rose-400/50 focus-visible:ring-rose-400/16"
                />
                <Button
                  className="bg-rose-700 text-white hover:bg-rose-600 focus-visible:border-rose-300/50 focus-visible:ring-rose-400/22"
                  onClick={onClearAll}
                  disabled={!isConfirmed || isClearingAll || isQueryPending}
                >
                  {isClearingAll ? "Clearing data..." : "Clear All Knowledge Bases"}
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-[16px] border border-white/10 bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-neutral-500">Last reset status</p>
            {lastResult ? (
              <div className="mt-4 space-y-4 text-sm text-neutral-200">
                <div className="rounded-[14px] border border-white/10 bg-white/[0.03] p-4">
                  <p className="font-medium text-white">{lastResult.message}</p>
                  <p className="mt-2 text-neutral-400">Executed {new Date(lastResult.clearedAt).toLocaleString()}</p>
                </div>
                <ResetResultSummary label="Neo4j" result={lastResult.cypherResult} />
                <ResetResultSummary label="PostgreSQL" result={lastResult.sqlResult} />
              </div>
            ) : (
              <div className="mt-4 rounded-[14px] border border-dashed border-white/10 p-4 text-sm text-neutral-400">
                No full reset has been executed in this browser session.
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SnippetPanel({
  title,
  code,
}: {
  title: string;
  code: string;
}) {
  return (
    <div className="rounded-[16px] border border-white/10 bg-black/25 p-4">
      <p className="text-xs uppercase tracking-[0.24em] text-neutral-500">{title}</p>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-[12px] bg-neutral-950/70 p-3 font-mono text-xs text-neutral-100">
        {code}
      </pre>
    </div>
  );
}

function ResetResultSummary({
  label,
  result,
}: {
  label: string;
  result: QueryExecutionResult;
}) {
  return (
    <div className="rounded-[14px] border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-white/10 text-neutral-100">{label}</Badge>
        <Badge className="bg-rose-300/90 text-rose-950">{result.statementType}</Badge>
        <Badge className="bg-white/10 text-neutral-100">{result.executionTimeMs} ms</Badge>
      </div>
      <p className="mt-3 text-sm text-neutral-300">{result.summary}</p>
      {result.warnings.length > 0 ? (
        <div className="mt-3 space-y-2">
          {result.warnings.map((warning) => (
            <p key={warning} className="text-xs text-amber-100/90">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EngineConsolePanel({
  engine,
  state,
  onQueryChange,
  onInspect,
  onExecute,
  onConfirmExecute,
  onReset,
}: {
  engine: QueryEngine;
  state: EngineState;
  onQueryChange: (query: string) => void;
  onInspect: () => void;
  onExecute: () => void;
  onConfirmExecute: () => void;
  onReset: () => void;
}) {
  const label = engine === "sql" ? "SQL" : "Cypher";
  const isPending = state.isInspecting || state.isExecuting;

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>{label} Editor</CardTitle>
          <CardDescription className="text-neutral-400">
            Single-statement {label} console with preview before destructive execution.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.22em] text-neutral-500">
            <Badge className="bg-white/10 text-neutral-100">{label}</Badge>
            <span>Single Statement</span>
            <span>Preview First</span>
          </div>

          <textarea
            value={state.query}
            onChange={(event) => onQueryChange(event.target.value)}
            spellCheck={false}
            className="min-h-[300px] w-full rounded-[16px] border border-white/10 bg-neutral-950/60 p-4 font-mono text-sm text-neutral-100 outline-none transition-colors focus:border-zinc-300/45"
            placeholder={DEFAULT_QUERIES[engine]}
          />

          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]"
              onClick={onInspect}
              disabled={isPending}
            >
              Preview
            </Button>
            <Button className="bg-zinc-300 text-neutral-950 hover:bg-zinc-200" onClick={onExecute} disabled={isPending}>
              Run Query
            </Button>
            <Button variant="ghost" className="text-neutral-300 hover:bg-white/[0.06]" onClick={onReset} disabled={isPending}>
              Clear
            </Button>
          </div>

          {state.confirmArmed && state.inspection?.isDestructive ? (
            <div className="rounded-[16px] border border-rose-400/35 bg-rose-500/10 p-4">
              <p className="text-sm font-medium text-rose-100">Destructive query detected</p>
              <p className="mt-2 text-sm text-rose-100/80">
                {state.inspection.statementType} can change or remove data in the {label} store. Review the preview and confirm if you want to execute it.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="destructive" onClick={onConfirmExecute} disabled={state.isExecuting}>
                  Confirm Execute
                </Button>
                <Button
                  variant="outline"
                  className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]"
                  onClick={() => onQueryChange(state.query)}
                  disabled={state.isExecuting}
                >
                  Keep Editing
                </Button>
              </div>
            </div>
          ) : null}

          {state.inspection ? <InspectionSummary inspection={state.inspection} /> : null}
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <CardDescription className="text-neutral-400">
            Preview metadata, execution summary, and result rows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.result ? (
            <ResultsPanel result={state.result} />
          ) : state.inspection ? (
            <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-5 text-sm text-neutral-300">
              Preview complete. Execute the query to see returned rows or update counters.
            </div>
          ) : (
            <div className="flex min-h-[320px] items-center justify-center rounded-[16px] border border-dashed border-white/10 text-neutral-400">
              Preview or execute a query to inspect the result payload.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InspectionSummary({ inspection }: { inspection: QueryInspectionResult }) {
  return (
    <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
      <div className="flex flex-wrap gap-2">
        <Badge className="bg-white/10 text-neutral-100">{inspection.statementType}</Badge>
        <Badge className={inspection.isReadOnly ? "bg-emerald-300/90 text-emerald-950" : "bg-amber-300/90 text-amber-950"}>
          {inspection.isReadOnly ? "Read-only" : "Mutating"}
        </Badge>
        {inspection.isDestructive ? <Badge className="bg-rose-300/90 text-rose-950">Destructive</Badge> : null}
      </div>

      {inspection.targets.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Targets</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {inspection.targets.map((target) => (
              <Badge key={target} className="bg-white/10 text-neutral-100">
                {target}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {inspection.warnings.length > 0 ? (
        <div className="mt-4 space-y-2">
          {inspection.warnings.map((warning) => (
            <p key={warning} className="rounded-[12px] border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ResultsPanel({ result }: { result: QueryExecutionResult }) {
  return (
    <div className="space-y-4">
      <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-zinc-300 text-neutral-950">{result.statementType}</Badge>
          <Badge className="bg-white/10 text-neutral-100">{result.rowCount} rows</Badge>
          <Badge className="bg-white/10 text-neutral-100">{result.executionTimeMs} ms</Badge>
          {result.truncated ? <Badge className="bg-amber-300/90 text-amber-950">Truncated</Badge> : null}
        </div>
        <p className="mt-3 text-sm text-neutral-300">{result.summary}</p>
        {result.warnings.length > 0 ? (
          <div className="mt-3 space-y-2">
            {result.warnings.map((warning) => (
              <p key={warning} className="text-sm text-amber-100/90">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      {result.rows.length > 0 ? (
        <ScrollArea className="h-[360px] rounded-[16px] border border-white/10 bg-neutral-950/36">
          <table className="min-w-full divide-y divide-white/10 text-sm">
            <thead className="bg-neutral-950/70 text-neutral-400">
              <tr>
                {result.columns.map((column) => (
                  <th key={column} className="px-4 py-3 text-left font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 bg-white/[0.03]">
              {result.rows.map((row, rowIndex) => (
                <tr key={`${rowIndex}-${result.columns.join("|")}`} className="align-top transition-colors hover:bg-white/[0.04]">
                  {result.columns.map((column) => (
                    <td key={column} className="max-w-[320px] px-4 py-3 text-neutral-200">
                      <span className={cn("block whitespace-pre-wrap break-words font-mono text-xs", isComplexValue(row[column]) ? "text-sky-100" : "text-neutral-200")}>{formatCellValue(row[column])}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      ) : (
        <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-5 text-sm text-neutral-300">
          Query executed successfully, but no row payload was returned.
        </div>
      )}

      {result.counters && Object.keys(result.counters).length > 0 ? (
        <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Counters</p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-[12px] bg-neutral-950/70 p-3 text-xs text-neutral-200">
            {JSON.stringify(result.counters, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function HistoryPanel({
  history,
  onRestore,
  onClear,
}: {
  history: QueryHistoryEntry[];
  onRestore: (entry: QueryHistoryEntry) => void;
  onClear: () => void;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Session History</CardTitle>
            <CardDescription className="text-neutral-400">
              Query previews and executions stored only for this browser session.
            </CardDescription>
          </div>
          <Button variant="outline" className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]" onClick={onClear}>
            Clear History
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <div className="flex min-h-[240px] items-center justify-center rounded-[16px] border border-dashed border-white/10 text-neutral-400">
            Query history is empty for this session.
          </div>
        ) : (
          <div className="space-y-3">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="w-full rounded-[16px] border border-white/10 bg-neutral-950/40 p-4 text-left transition-all duration-150 hover:border-zinc-300/35 hover:bg-neutral-950/72 active:scale-[0.995]"
                onClick={() => onRestore(entry)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-white/10 text-neutral-100">{entry.engine.toUpperCase()}</Badge>
                  <Badge className="bg-white/10 text-neutral-100">{entry.action}</Badge>
                  <Badge className={entry.status === "success" ? "bg-emerald-300/90 text-emerald-950" : "bg-rose-300/90 text-rose-950"}>
                    {entry.status}
                  </Badge>
                  {entry.isDestructive ? <Badge className="bg-amber-300/90 text-amber-950">Destructive</Badge> : null}
                </div>
                <p className="mt-3 text-sm font-medium text-white">{entry.summary}</p>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap font-mono text-xs text-neutral-400">{entry.query}</p>
                <p className="mt-3 text-xs uppercase tracking-[0.22em] text-neutral-500">
                  {entry.statementType} · {new Date(entry.createdAt).toLocaleString()}
                  {typeof entry.rowCount === "number" ? ` · ${entry.rowCount} rows` : ""}
                </p>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function loadHistory(): QueryHistoryEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as QueryHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isComplexValue(value: unknown) {
  return typeof value === "object" && value !== null;
}

function formatCellValue(value: unknown) {
  if (value == null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function toInspectionResult(result: QueryExecutionResult): QueryInspectionResult {
  return {
    engine: result.engine,
    mode: "inspect",
    query: result.query,
    normalizedQuery: result.normalizedQuery,
    statementType: result.statementType,
    isReadOnly: result.isReadOnly,
    isDestructive: result.isDestructive,
    warnings: result.warnings,
    targets: result.targets,
    timeoutMs: result.timeoutMs,
    maxRows: result.maxRows,
  };
}