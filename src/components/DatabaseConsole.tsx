import { useEffect, useRef, useState, useTransition } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Copy,
  Database,
  FileStack,
  GitBranch,
  HardDriveUpload,
  CheckCircle2,
  LoaderCircle,
  MessageSquare,
  Orbit,
  RefreshCw,
  ServerCog,
  Sparkles,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { MemoryService, type DocumentDetail, type DocumentImportStatusSummary, type DocumentRecord, type EpisodicMemory, type GraphSnapshot, type JobRecord, type OverviewMetrics, type PipelineEvent, type SemanticFact } from "../lib/memoryService";
import MtmGraph from "./MtmGraph";
import QueryConsoleView from "./QueryConsoleView";

const navItems = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/documents", label: "Document Loader", icon: HardDriveUpload },
  { to: "/conversations", label: "Conversation Hook", icon: MessageSquare },
  { to: "/stm", label: "STM Base", icon: Database },
  { to: "/mtm", label: "MTM Network", icon: Orbit },
  { to: "/ltm", label: "LTM Store", icon: Sparkles },
  { to: "/console", label: "Data Console", icon: ServerCog },
  { to: "/jobs", label: "Logs", icon: GitBranch },
];

const documentImportSteps = [
  { stage: "uploaded", label: "Upload" },
  { stage: "parsing", label: "Parse" },
  { stage: "writing_stm", label: "Chunk to STM" },
  { stage: "promoting_mtm", label: "Promote to MTM" },
  { stage: "refreshing_graph", label: "Refresh Graph" },
] as const;

const documentStageLabels: Record<string, string> = {
  uploaded: "Upload received",
  parsing: "Parsing with Docling",
  writing_stm: "Chunking into STM",
  promoting_mtm: "Promoting into MTM",
  refreshing_graph: "Refreshing MTM graph",
  completed: "Import completed",
  failed: "Import failed",
};

const sleepCycleSteps = [
  { key: "project_graph", label: "Project Graph", stages: ["project_graph"] },
  { key: "rank_cluster", label: "Score & Cluster", stages: ["rank_nodes", "cluster_communities"] },
  { key: "distill_facts", label: "Distill to LTM", stages: ["distill_facts"] },
  { key: "cleanup", label: "Cleanup", stages: ["cleanup", "completed"] },
] as const;

const STM_PAGE_SIZE = 20;
const LTM_PAGE_SIZE = 8;

const sleepCycleStageLabels: Record<string, string> = {
  project_graph: "Projecting the MTM graph",
  rank_nodes: "Ranking nodes for pruning",
  cluster_communities: "Clustering MTM communities",
  distill_facts: "Committing MTM to LTM",
  cleanup: "Pruning nodes and closing the graph",
  completed: "Sleep cycle completed",
  failed: "Sleep cycle failed",
};

type DocumentStepState = "complete" | "current" | "pending" | "error";

function isDocumentImportActive(status: string) {
  return status === "queued" || status === "running";
}

function getDocumentStageLabel(stage: string) {
  return documentStageLabels[stage] ?? stage.replace(/_/g, " ");
}

function getDocumentStatusBadgeClass(status: string) {
  switch (status) {
    case "completed":
      return "bg-emerald-300/90 text-emerald-950";
    case "failed":
      return "bg-rose-300/90 text-rose-950";
    case "running":
      return "bg-zinc-300 text-neutral-950";
    default:
      return "bg-white/10 text-neutral-100";
  }
}

function getDocumentProgressBarClass(status: string) {
  switch (status) {
    case "completed":
    case "failed":
    default:
      return "bg-white";
  }
}

function getDocumentProgressValue(summary: DocumentImportStatusSummary) {
  if (summary.status === "completed") {
    return 100;
  }

  if (summary.status === "queued") {
    return Math.max(summary.progress, 6);
  }

  return Math.max(summary.progress, 0);
}

function getDocumentImportStageKey(summary: DocumentImportStatusSummary) {
  if (documentImportSteps.some((step) => step.stage === summary.stage)) {
    return summary.stage;
  }

  if (summary.latestEventStage && documentImportSteps.some((step) => step.stage === summary.latestEventStage)) {
    return summary.latestEventStage;
  }

  return summary.stage;
}

function getDocumentStepState(summary: DocumentImportStatusSummary, stepStage: string): DocumentStepState {
  if (summary.status === "completed") {
    return "complete";
  }

  const activeStage = getDocumentImportStageKey(summary);
  const activeIndex = documentImportSteps.findIndex((step) => step.stage === activeStage);
  const stepIndex = documentImportSteps.findIndex((step) => step.stage === stepStage);

  if (summary.status === "failed") {
    if (activeStage === stepStage) {
      return "error";
    }

    if (activeIndex >= 0 && stepIndex < activeIndex) {
      return "complete";
    }

    return "pending";
  }

  if (summary.status === "queued") {
    return stepStage === "uploaded" ? "current" : "pending";
  }

  if (activeStage === stepStage) {
    return "current";
  }

  if (activeIndex >= 0 && stepIndex < activeIndex) {
    return "complete";
  }

  return "pending";
}

function getDocumentStepCardClass(state: DocumentStepState) {
  switch (state) {
    case "complete":
      return "border-emerald-300/25 bg-emerald-300/10";
    case "current":
      return "border-zinc-300/35 bg-zinc-300/10";
    case "error":
      return "border-rose-300/25 bg-rose-300/10";
    default:
      return "border-white/10 bg-white/[0.03]";
  }
}

function getDocumentStepTextClass(state: DocumentStepState) {
  switch (state) {
    case "complete":
      return "text-emerald-100";
    case "current":
      return "text-white";
    case "error":
      return "text-rose-100";
    default:
      return "text-neutral-300";
  }
}

function getDocumentStatusCounts(documents: DocumentRecord[]) {
  return documents.reduce<Record<string, number>>((accumulator, document) => {
    const status = document.statusSummary.status;
    accumulator[status] = (accumulator[status] ?? 0) + 1;
    return accumulator;
  }, {});
}

function getDocumentMetaLine(document: DocumentRecord | DocumentDetail) {
  const summary = document.statusSummary;

  if (summary.status === "completed") {
    return `${document.chunkCount} chunks · ${document.parserName}`;
  }

  if (summary.status === "failed") {
    return summary.errorMessage ?? document.lastError ?? "Import failed before completion";
  }

  return summary.latestEventMessage ?? getDocumentStageLabel(summary.stage);
}

function formatStatusTimestamp(value: string | null) {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleString();
}

function getTotalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

function isSleepCycleJob(job: JobRecord) {
  return job.jobType === "sleep_cycle";
}

function getSleepCycleStageLabel(stage: string) {
  return sleepCycleStageLabels[stage] ?? stage.replace(/_/g, " ");
}

function getSleepCycleStepKey(stage: string) {
  return sleepCycleSteps.find((step) => step.stages.includes(stage as never))?.key ?? stage;
}

function getSleepCycleStepState(job: JobRecord, stepKey: string): DocumentStepState {
  if (job.status === "completed") {
    return "complete";
  }

  const activeStep = getSleepCycleStepKey(job.stage);
  const activeIndex = sleepCycleSteps.findIndex((step) => step.key === activeStep);
  const stepIndex = sleepCycleSteps.findIndex((step) => step.key === stepKey);

  if (job.status === "failed") {
    if (activeStep === stepKey) {
      return "error";
    }

    if (activeIndex >= 0 && stepIndex < activeIndex) {
      return "complete";
    }

    return "pending";
  }

  if (job.status === "queued") {
    return stepKey === "project_graph" ? "current" : "pending";
  }

  if (activeStep === stepKey) {
    return "current";
  }

  if (activeIndex >= 0 && stepIndex < activeIndex) {
    return "complete";
  }

  return "pending";
}

function getLatestEventForJob(jobId: string | null, events: PipelineEvent[]) {
  if (!jobId) {
    return null;
  }

  return events.find((event) => event.jobId === jobId) ?? null;
}

function getNumericPayloadValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getSleepCycleSummaryLine(job: JobRecord, event: PipelineEvent | null) {
  const payload = event?.payload ?? {};
  const consolidated = getNumericPayloadValue(job.metadata, "consolidated") ?? getNumericPayloadValue(payload, "consolidated");
  const pruned = getNumericPayloadValue(job.metadata, "pruned") ?? getNumericPayloadValue(payload, "pruned");
  const processedCommunities = getNumericPayloadValue(payload, "processedCommunities");
  const totalCommunities = getNumericPayloadValue(payload, "totalCommunities");
  const eligibleCommunities = getNumericPayloadValue(payload, "eligibleCommunities");
  const nodesToPrune = getNumericPayloadValue(payload, "nodesToPrune");

  if (job.status === "completed") {
    if (event?.message.includes("skipped")) {
      return event.message;
    }

    return `${consolidated ?? 0} facts consolidated to LTM · ${pruned ?? 0} MTM nodes pruned`;
  }

  if (job.status === "failed") {
    return job.errorMessage ?? event?.message ?? "Sleep cycle failed before completion";
  }

  if (processedCommunities !== null && totalCommunities !== null) {
    return `${processedCommunities} of ${totalCommunities} communities distilled · ${consolidated ?? 0} facts committed`;
  }

  if (eligibleCommunities !== null) {
    return `${eligibleCommunities} communities ready for LTM distillation`;
  }

  if (nodesToPrune !== null) {
    return `${nodesToPrune} MTM nodes marked for pruning`;
  }

  return event?.message ?? `${job.progress}% through the current sleep cycle.`;
}

function getSleepCycleProgressValue(job: JobRecord, event: PipelineEvent | null) {
  return getDocumentProgressValue({
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    errorMessage: job.errorMessage,
    latestEventMessage: event?.message ?? null,
    latestEventStage: event?.stage ?? null,
    latestEventLevel: event?.level ?? null,
    latestEventAt: event?.createdAt ?? null,
    updatedAt: job.updatedAt,
  });
}

export default function DatabaseConsole() {
  const [health, setHealth] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null);
  const [stm, setStm] = useState<{ entries: EpisodicMemory[]; total: number }>({ entries: [], total: 0 });
  const [ltm, setLtm] = useState<{ facts: SemanticFact[]; total: number }>({ facts: [], total: 0 });
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [graph, setGraph] = useState<GraphSnapshot>({
    nodes: [],
    edges: [],
    stats: {
      nodeCount: 0,
      edgeCount: 0,
      communityCount: 0,
      episodicNodeCount: 0,
      annotatedNodeCount: 0,
      similarityEdgeCount: 0,
      overlapEdgeCount: 0,
    },
  });
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [stmQuery, setStmQuery] = useState("");
  const [stmPage, setStmPage] = useState(1);
  const [ltmPage, setLtmPage] = useState(1);
  const [isPending, startTransition] = useTransition();
  const location = useLocation();
  const navigate = useNavigate();
  const hasActiveImports = documents.some((document) => isDocumentImportActive(document.statusSummary.status));
  const latestSleepCycleJob = jobs.find(isSleepCycleJob) ?? null;
  const latestSleepCycleEvent = getLatestEventForJob(latestSleepCycleJob?.jobId ?? null, events);
  const hasActiveSleepCycle = jobs.some((job) => isSleepCycleJob(job) && isDocumentImportActive(job.status));
  const hasActivePipelineWork = hasActiveImports || hasActiveSleepCycle;
  const previousHasActiveImportsRef = useRef(false);
  const previousHasActiveSleepCycleRef = useRef(false);

  const resolveFocusedDocumentId = (documentResult: DocumentRecord[], preferredDocumentId?: string) => {
    if (preferredDocumentId && documentResult.some((document) => document.documentId === preferredDocumentId)) {
      return preferredDocumentId;
    }

    if (selectedDocument && documentResult.some((document) => document.documentId === selectedDocument.documentId)) {
      return selectedDocument.documentId;
    }

    return documentResult[0]?.documentId;
  };

  const loadFocusedDocumentDetail = async (
    documentResult: DocumentRecord[],
    preferredDocumentId?: string,
    silent = false
  ) => {
    const focusedDocumentId = resolveFocusedDocumentId(documentResult, preferredDocumentId);
    if (!focusedDocumentId) {
      return null;
    }

    try {
      return await MemoryService.getDocumentDetail(focusedDocumentId);
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : "Failed to load document detail");
      }
      return selectedDocument && documentResult.some((document) => document.documentId === selectedDocument.documentId)
        ? selectedDocument
        : null;
    }
  };

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const totalPages = getTotalPages(stm.total, STM_PAGE_SIZE);
    if (stmPage > totalPages) {
      void refreshStm(totalPages, stmQuery);
    }
  }, [stm.total, stmPage, stmQuery]);

  useEffect(() => {
    const totalPages = getTotalPages(ltm.total, LTM_PAGE_SIZE);
    if (ltmPage > totalPages) {
      void refreshLtm(totalPages);
    }
  }, [ltm.total, ltmPage]);

  useEffect(() => {
    if (!hasActivePipelineWork) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshDocumentStatus({ silent: true });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [hasActivePipelineWork, selectedDocument?.documentId]);

  useEffect(() => {
    if (previousHasActiveImportsRef.current && !hasActiveImports) {
      void refreshAll(selectedDocument?.documentId);
    }

    previousHasActiveImportsRef.current = hasActiveImports;
  }, [hasActiveImports, selectedDocument?.documentId]);

  useEffect(() => {
    if (previousHasActiveSleepCycleRef.current && !hasActiveSleepCycle && latestSleepCycleJob) {
      if (latestSleepCycleJob.status === "completed") {
        if (latestSleepCycleEvent?.message.includes("skipped")) {
          toast.info(latestSleepCycleEvent.message);
        } else {
          const consolidated = getNumericPayloadValue(latestSleepCycleJob.metadata, "consolidated") ?? 0;
          const pruned = getNumericPayloadValue(latestSleepCycleJob.metadata, "pruned") ?? 0;
          toast.success(`Sleep-cycle distilled ${consolidated} facts and pruned ${pruned} nodes`);
        }
      } else if (latestSleepCycleJob.status === "failed") {
        toast.error(latestSleepCycleJob.errorMessage ?? "Sleep-cycle failed");
      }

      void refreshAll(selectedDocument?.documentId);
    }

    previousHasActiveSleepCycleRef.current = hasActiveSleepCycle;
  }, [
    hasActiveSleepCycle,
    latestSleepCycleJob?.jobId,
    latestSleepCycleJob?.status,
    latestSleepCycleJob?.errorMessage,
    latestSleepCycleEvent?.message,
    selectedDocument?.documentId,
  ]);

  const refreshDocumentStatus = async (options?: { preferredDocumentId?: string; silent?: boolean }) => {
    try {
      const [documentResult, jobResult, eventResult] = await Promise.all([
        MemoryService.listDocuments(),
        MemoryService.listJobs(50),
        MemoryService.listPipelineEvents({ limit: 50 }),
      ]);
      const detailResult = await loadFocusedDocumentDetail(documentResult, options?.preferredDocumentId, options?.silent ?? false);

      setDocuments(documentResult);
      setJobs(jobResult);
      setEvents(eventResult);
      setSelectedDocument(detailResult);
    } catch (error) {
      if (!options?.silent) {
        toast.error(error instanceof Error ? error.message : "Failed to refresh document status");
      }
    }
  };

  const refreshAll = async (preferredDocumentId?: string) => {
    startTransition(() => {
      void (async () => {
        try {
          const [healthResult, metricsResult, documentResult, stmResult, graphResult, ltmResult, jobResult, eventResult] = await Promise.all([
            MemoryService.testConnection(),
            MemoryService.getOverviewMetrics(),
            MemoryService.listDocuments(),
            MemoryService.listStmEntries({ page: stmPage, pageSize: STM_PAGE_SIZE, query: stmQuery || undefined }),
            MemoryService.getGraph(),
            MemoryService.listLtmFacts(ltmPage, LTM_PAGE_SIZE),
            MemoryService.listJobs(50),
            MemoryService.listPipelineEvents({ limit: 50 }),
          ]);
          const detailResult = await loadFocusedDocumentDetail(documentResult, preferredDocumentId);

          setHealth(healthResult.services);
          setMetrics(metricsResult);
          setDocuments(documentResult);
          setStm(stmResult);
          setGraph(graphResult);
          setLtm(ltmResult);
          setJobs(jobResult);
          setEvents(eventResult);
          setSelectedDocument(detailResult);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to refresh console data");
        }
      })();
    });
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error("Select at least one document to import");
      return;
    }

    startTransition(() => {
      void (async () => {
        try {
          const result = await MemoryService.importDocuments(selectedFiles);
          toast.success(result.documents.length === 1 ? "Document queued for ingestion" : "Documents queued for ingestion");
          setSelectedFiles([]);
          await refreshAll(result.documents[0]?.documentId);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Document import failed");
        }
      })();
    });
  };

  const handleSleepCycle = async () => {
    startTransition(() => {
      void (async () => {
        try {
          await MemoryService.runSleepCycle();
          toast.success("Sleep-cycle queued");
          await refreshDocumentStatus({ silent: true });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Sleep-cycle failed");
        }
      })();
    });
  };

  const openDocument = async (documentId: string) => {
    try {
      const detail = await MemoryService.getDocumentDetail(documentId);
      setSelectedDocument(detail);
      if (location.pathname !== "/documents") {
        navigate("/documents");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load document detail");
    }
  };

  const refreshStm = async (page: number = stmPage, query: string = stmQuery) => {
    try {
      const normalizedPage = Math.max(page, 1);
      const result = await MemoryService.listStmEntries({ page: normalizedPage, pageSize: STM_PAGE_SIZE, query: query || undefined });
      setStm(result);
      setStmPage(normalizedPage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to filter STM");
    }
  };

  const refreshLtm = async (page: number = ltmPage) => {
    try {
      const normalizedPage = Math.max(page, 1);
      const result = await MemoryService.listLtmFacts(normalizedPage, LTM_PAGE_SIZE);
      setLtm(result);
      setLtmPage(normalizedPage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load LTM facts");
    }
  };

  const chartData = metrics
    ? [
      { label: "Documents", value: metrics.cards.documents },
      { label: "Chunks", value: metrics.cards.chunks },
      { label: "STM", value: metrics.cards.stm },
      { label: "MTM", value: metrics.cards.mtm },
      { label: "LTM", value: metrics.cards.ltm },
    ]
    : [];

  return (
    <div className="min-h-screen bg-black text-neutral-100">
      <div className="mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 gap-5 px-4 py-5 lg:grid-cols-[228px_minmax(0,1fr)] lg:px-6">
        <aside className="rounded-[18px] border border-white/10 bg-neutral-900/50 p-4 shadow-[0_18px_50px_rgba(2,6,23,0.34)] backdrop-blur-xl">
          <div className="mb-8 space-y-2">
            <p className="text-xs uppercase tracking-[0.3em] text-zinc-300/70">Neuro-Hierarchical</p>
            <h1 className="font-heading text-2xl font-semibold tracking-tight text-white">RAG Ops</h1>
            <p className="text-sm leading-6 text-neutral-400">Biomimetic Agentic Memory Consolidation & Algorithmic Forgetting.</p>
          </div>

          <nav className="space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-[14px] border px-3 py-3 text-sm transition-all duration-150 ${isActive
                      ? "border-zinc-300/35 bg-zinc-300/90 text-neutral-950 shadow-[0_12px_32px_rgba(56,189,248,0.24)]"
                      : "border-transparent text-neutral-300 hover:border-white/10 hover:bg-white/6 hover:text-white active:scale-[0.99]"
                    }`
                  }
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>

          <Card className="mt-8 border-white/10 bg-white/4 text-neutral-100 shadow-none hover:tranneutral-y-0">
            <CardHeader>
              <CardTitle className="text-sm">Infrastructure</CardTitle>
              <CardDescription className="text-neutral-400">Current service health</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {Object.entries(health).map(([service, status]) => (
                <div key={service} className="flex items-center justify-between rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-white/16 hover:bg-white/[0.05]">
                  <span className="capitalize text-neutral-300">{service}</span>
                  <Badge className={status === "ok" ? "bg-emerald-300/90 text-emerald-950" : "bg-rose-300/90 text-rose-950"}>{status}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </aside>

        <main className="space-y-6">
          <div className="flex flex-col gap-4 rounded-[18px] border border-white/10 bg-neutral-900/50 p-5 shadow-[0_12px_32px_rgba(2,6,23,0.24)] backdrop-blur-xl xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-neutral-500">Memory Layer</p>
              <h2 className="mt-1 font-heading text-3xl font-semibold">{navItems.find((item) => (item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to)))?.label ?? "Overview"}</h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]" onClick={() => void refreshAll()}>
                <RefreshCw className={`mr-2 h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button className="bg-zinc-300 text-neutral-950 hover:bg-zinc-200" disabled={hasActiveSleepCycle} onClick={() => void handleSleepCycle()}>
                <ServerCog className="mr-2 h-4 w-4" />
                {hasActiveSleepCycle ? "Sleep-Cycle Running" : "Run Sleep-Cycle"}
              </Button>
            </div>
          </div>

          {latestSleepCycleJob ? <SleepCycleStatusCard job={latestSleepCycleJob} event={latestSleepCycleEvent} /> : null}

          <Routes>
            <Route
              path="/"
              element={
                <OverviewView
                  metrics={metrics}
                  chartData={chartData}
                  openDocument={openDocument}
                />
              }
            />
            <Route
              path="/documents"
              element={
                <DocumentsView
                  documents={documents}
                  selectedDocument={selectedDocument}
                  selectedFiles={selectedFiles}
                  setSelectedFiles={setSelectedFiles}
                  handleUpload={handleUpload}
                  isPending={isPending}
                  openDocument={openDocument}
                />
              }
            />
            <Route
              path="/console"
              element={<QueryConsoleView onDataMutation={refreshAll} />}
            />
            <Route
              path="/stm"
              element={
                <StmView
                  stm={stm}
                  page={stmPage}
                  pageSize={STM_PAGE_SIZE}
                  query={stmQuery}
                  setQuery={setStmQuery}
                  refreshStm={refreshStm}
                />
              }
            />
            <Route path="/mtm" element={<MtmView graph={graph} />} />
            <Route path="/ltm" element={<LtmView ltm={ltm} page={ltmPage} pageSize={LTM_PAGE_SIZE} refreshLtm={refreshLtm} />} />
            <Route path="/jobs" element={<JobsView jobs={jobs} events={events} />} />
            <Route path="/conversations" element={<ConversationHookView />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function OverviewView({
  metrics,
  chartData,
  openDocument,
}: {
  metrics: OverviewMetrics | null;
  chartData: Array<{ label: string; value: number }>;
  openDocument: (documentId: string) => Promise<void>;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            { label: "Documents", value: metrics?.cards.documents ?? 0 },
            { label: "Chunks", value: metrics?.cards.chunks ?? 0 },
            { label: "STM Rows", value: metrics?.cards.stm ?? 0 },
            { label: "MTM Nodes", value: metrics?.cards.mtm ?? 0 },
            { label: "LTM Facts", value: metrics?.cards.ltm ?? 0 },
          ].map((card) => (
            <Card key={card.label} className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
              <CardHeader>
                <CardDescription className="text-neutral-400">{card.label}</CardDescription>
                <CardTitle className="text-3xl font-semibold">{card.value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>

        <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
          <CardHeader>
            <CardTitle>Tier Footprint</CardTitle>
            <CardDescription className="text-neutral-400">Current database distribution across the memory tiers</CardDescription>
          </CardHeader>
          <CardContent className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ left: 12, right: 12, top: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="tierFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#7dd3fc" stopOpacity={0.8} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.08} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(226,232,240,0.7)" />
                <YAxis stroke="rgba(226,232,240,0.7)" allowDecimals={false} />
                <Tooltip contentStyle={{ background: "#08101b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14 }} />
                <Area type="monotone" dataKey="value" stroke="#7dd3fc" fill="url(#tierFill)" strokeWidth={2.5} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
          <CardHeader>
            <CardTitle>Recent Pipeline Jobs</CardTitle>
            <CardDescription className="text-neutral-400">Most recent ingestion and consolidation activity</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(metrics?.recentJobs ?? []).slice(0, 6).map((job) => (
              <div key={job.jobId} className="rounded-[14px] border border-white/10 bg-neutral-900/50 p-3 transition-colors hover:border-white/16 hover:bg-neutral-950/72">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">{job.jobType}</p>
                    <p className="text-xs uppercase tracking-[0.2em] text-neutral-400">{job.stage}</p>
                  </div>
                  <Badge className="bg-white/10 text-neutral-100">{job.status}</Badge>
                </div>
                <p className="mt-2 text-sm text-neutral-300">Progress {job.progress}%</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
          <CardHeader>
            <CardTitle>Recent Document Activity</CardTitle>
            <CardDescription className="text-neutral-400">Jump straight into the latest imported documents</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(metrics?.recentEvents ?? []).slice(0, 6).map((event) => (
              <button
                key={event.eventId}
                type="button"
                className="group w-full rounded-[14px] border border-white/10 bg-neutral-950/40 p-3 text-left transition-all duration-150 hover:border-zinc-300/40 hover:bg-neutral-950/72 active:scale-[0.995]"
                onClick={() => (event.documentId ? void openDocument(event.documentId) : undefined)}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-white">{event.message}</p>
                  <ArrowUpRight className="h-4 w-4 text-neutral-500 transition-transform group-hover:tranneutral-x-0.5" />
                </div>
                <p className="mt-1 text-xs uppercase tracking-[0.24em] text-neutral-500">{event.stage}</p>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DocumentsView({
  documents,
  selectedDocument,
  selectedFiles,
  setSelectedFiles,
  handleUpload,
  isPending,
  openDocument,
}: {
  documents: DocumentRecord[];
  selectedDocument: DocumentDetail | null;
  selectedFiles: File[];
  setSelectedFiles: (files: File[]) => void;
  handleUpload: () => Promise<void>;
  isPending: boolean;
  openDocument: (documentId: string) => Promise<void>;
}) {
  const statusCounts = getDocumentStatusCounts(documents);

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-6">
        <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
          <CardHeader>
            <CardTitle>Doc Import Workspace</CardTitle>
            <CardDescription className="text-neutral-400">Upload one or more files into STM, then track parse, chunking, and MTM promotion as each document moves through the pipeline.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-[16px] border border-dashed border-zinc-300/30 bg-neutral-950/42 px-6 text-center transition-all duration-150 hover:border-zinc-300/70 hover:bg-neutral-950/72 hover:shadow-[0_18px_40px_rgba(14,165,233,0.12)] active:scale-[0.998]">
              <FileStack className="mb-3 h-8 w-8 text-zinc-300" />
              <span className="text-lg font-medium">Drop files here or browse</span>
              <span className="mt-1 text-sm text-neutral-400">PDF, DOCX, PPTX, Markdown, text, and other Docling-supported formats</span>
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
              />
            </label>
            {selectedFiles.length > 0 ? (
              <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
                <p className="mb-3 text-sm font-medium text-white">Ready to import</p>
                <div className="space-y-2">
                  {selectedFiles.map((file) => (
                    <div key={`${file.name}-${file.size}`} className="flex items-center justify-between rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
                      <span>{file.name}</span>
                      <span className="text-neutral-400">{formatBytes(file.size)}</span>
                    </div>
                  ))}
                </div>
                <Button className="mt-4 bg-zinc-300 text-neutral-950 hover:bg-zinc-200" disabled={isPending} onClick={() => void handleUpload()}>
                  {isPending ? "Queueing import..." : "Queue Import"}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
          <CardHeader>
            <CardTitle>Imported Documents</CardTitle>
            <CardDescription className="text-neutral-400">Persisted document records with current upload, chunking, and MTM promotion state.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {documents.length > 0 ? (
              <div className="flex flex-wrap gap-2 pb-1">
                {[
                  { status: "queued", label: "Queued" },
                  { status: "running", label: "Running" },
                  { status: "completed", label: "Completed" },
                  { status: "failed", label: "Failed" },
                ].map(({ status, label }) =>
                  statusCounts[status] ? (
                    <div key={status} className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.22em] ${getDocumentStatusBadgeClass(status)}`}>
                      {statusCounts[status]} {label}
                    </div>
                  ) : null
                )}
              </div>
            ) : null}
            {documents.length === 0 ? (
              <div className="rounded-[16px] border border-dashed border-white/10 bg-neutral-950/30 px-4 py-10 text-center text-sm text-neutral-400">
                No documents have been imported yet.
              </div>
            ) : null}
            {documents.map((document) => {
              const summary = document.statusSummary;
              const updatedAt = formatStatusTimestamp(summary.latestEventAt ?? summary.updatedAt);
              const isSelected = selectedDocument?.documentId === document.documentId;

              return (
                <button
                  key={document.documentId}
                  type="button"
                  className={`w-full rounded-[14px] border p-3 text-left transition-all duration-150 active:scale-[0.995] ${isSelected
                      ? "border-zinc-300/40 bg-neutral-900/80 shadow-[0_12px_28px_rgba(255,255,255,0.08)]"
                      : "border-white/10 bg-neutral-950/40 hover:border-zinc-300/35 hover:bg-neutral-950/72"
                    }`}
                  onClick={() => void openDocument(document.documentId)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-white">{document.filename}</p>
                        {summary.status === "completed" ? (
                          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
                            {document.chunkCount} chunks
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] text-neutral-500">
                        <span>{getDocumentStageLabel(summary.stage)}</span>
                        <span>{summary.progress}%</span>
                        {updatedAt ? <span>{updatedAt}</span> : null}
                      </div>
                    </div>
                    <Badge className={getDocumentStatusBadgeClass(summary.status)}>{summary.status}</Badge>
                  </div>

                  <p className={`mt-2 truncate text-sm ${summary.status === "failed" ? "text-rose-300" : "text-neutral-300"}`}>
                    {getDocumentMetaLine(document)}
                  </p>

                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full ${getDocumentProgressBarClass(summary.status)}`} style={{ width: `${getDocumentProgressValue(summary)}%` }} />
                  </div>
                </button>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>Document Detail</CardTitle>
          <CardDescription className="text-neutral-400">Inspect chunk lineage and the document-specific event stream.</CardDescription>
        </CardHeader>
        <CardContent>
          {selectedDocument ? (
            <div className="space-y-5">
              <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold text-white">{selectedDocument.filename}</h3>
                    <p className="mt-1 text-sm text-neutral-400">{selectedDocument.mimeType} · {formatBytes(selectedDocument.fileSizeBytes)}</p>
                  </div>
                  <Badge className={getDocumentStatusBadgeClass(selectedDocument.statusSummary.status)}>{selectedDocument.statusSummary.status}</Badge>
                </div>
                {selectedDocument.summary ? <p className="mt-4 text-sm text-neutral-300">{selectedDocument.summary}</p> : null}
              </div>

              <DocumentImportStatusPanel document={selectedDocument} />

              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <p className="mb-3 text-sm font-medium uppercase tracking-[0.22em] text-neutral-400">Chunks</p>
                  <ScrollArea className="h-[420px] rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
                    <div className="space-y-3">
                      {selectedDocument.chunks.map((chunk) => (
                        <div key={chunk.chunkId} className="rounded-[14px] border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-white/16 hover:bg-white/[0.05]">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium text-white">Chunk {chunk.chunkIndex + 1}</p>
                            <span className="text-xs uppercase tracking-[0.2em] text-neutral-500">{chunk.tokenEstimate} tok</span>
                          </div>
                          <p className="mt-2 text-sm text-neutral-300">{chunk.contentText.slice(0, 280)}</p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>

                <div>
                  <p className="mb-3 text-sm font-medium uppercase tracking-[0.22em] text-neutral-400">Pipeline Events</p>
                  <ScrollArea className="h-[420px] rounded-[16px] border border-white/10 bg-neutral-900/50 p-4">
                    <div className="space-y-3">
                      {selectedDocument.events.map((event) => (
                        <div key={event.eventId} className="rounded-[14px] border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-white/16 hover:bg-white/[0.05]">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium text-white">{event.message}</p>
                            <Badge className="bg-white/10 text-neutral-100">{event.stage}</Badge>
                          </div>
                          <p className="mt-2 text-xs uppercase tracking-[0.2em] text-neutral-500">{new Date(event.createdAt).toLocaleString()}</p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[400px] items-center justify-center rounded-[16px] border border-dashed border-white/10 text-neutral-400">
              Select a document to inspect its chunks and event timeline.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DocumentImportStatusPanel({ document }: { document: DocumentRecord | DocumentDetail }) {
  const summary = document.statusSummary;
  const isActive = isDocumentImportActive(summary.status);
  const [isExpanded, setIsExpanded] = useState(isActive);
  const previousDocumentIdRef = useRef(document.documentId);
  const updatedAt = formatStatusTimestamp(summary.latestEventAt ?? summary.updatedAt);
  const summaryLine = getDocumentMetaLine(document);

  useEffect(() => {
    if (previousDocumentIdRef.current !== document.documentId) {
      previousDocumentIdRef.current = document.documentId;
      setIsExpanded(isActive);
    }
  }, [document.documentId, isActive]);

  return (
    <div className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Import Status</p>
          <h4 className="mt-2 text-lg font-semibold text-white">{getDocumentStageLabel(summary.stage)}</h4>
          <p className="mt-1 text-sm text-neutral-400">
            {summary.status === "completed"
              ? `${document.chunkCount} chunks are loaded and MTM promotion has completed.`
              : summary.status === "failed"
                ? "The import stopped before all promotion steps completed."
                : `${summary.progress}% through the current ingestion flow.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={getDocumentStatusBadgeClass(summary.status)}>{summary.status}</Badge>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-neutral-300 transition-colors hover:border-white/16 hover:bg-white/[0.06]"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "Hide Details" : "Show Details"}
            <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : "rotate-0"}`} />
          </button>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${getDocumentProgressBarClass(summary.status)}`} style={{ width: `${getDocumentProgressValue(summary)}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.2em] text-neutral-500">
        <span>{updatedAt ? `Updated ${updatedAt}` : getDocumentStageLabel(summary.stage)}</span>
        <span>{summaryLine}</span>
      </div>

      {isExpanded ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {documentImportSteps.map((step) => {
              const stepState = getDocumentStepState(summary, step.stage);

              return (
                <div key={step.stage} className={`rounded-[14px] border p-3 ${getDocumentStepCardClass(stepState)}`}>
                  <div className="flex items-center gap-2">
                    {stepState === "complete" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    ) : stepState === "current" ? (
                      <LoaderCircle className="h-4 w-4 animate-spin text-zinc-300" />
                    ) : stepState === "error" ? (
                      <AlertTriangle className="h-4 w-4 text-rose-300" />
                    ) : (
                      <div className="h-2.5 w-2.5 rounded-full bg-white/20" />
                    )}
                    <p className={`text-sm font-medium ${getDocumentStepTextClass(stepState)}`}>{step.label}</p>
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-[0.2em] text-neutral-500">
                    {stepState === "complete" ? "done" : stepState === "current" ? "active" : stepState === "error" ? "error" : "pending"}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="rounded-[14px] border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Latest activity</p>
                <p className="mt-2 text-sm text-neutral-200">{summaryLine}</p>
              </div>
              {updatedAt ? <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">{updatedAt}</p> : null}
            </div>
            {summary.latestEventMessage && summary.latestEventMessage !== summaryLine ? <p className="mt-3 text-sm text-neutral-300">{summary.latestEventMessage}</p> : null}
            {summary.errorMessage ? <p className="mt-3 text-sm text-rose-300">{summary.errorMessage}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SleepCycleStatusCard({ job, event }: { job: JobRecord; event: PipelineEvent | null }) {
  const isActive = isDocumentImportActive(job.status);
  const [isExpanded, setIsExpanded] = useState(isActive);
  const previousJobIdRef = useRef(job.jobId);
  const updatedAt = formatStatusTimestamp(event?.createdAt ?? job.updatedAt);
  const summaryLine = getSleepCycleSummaryLine(job, event);
  const progressValue = getSleepCycleProgressValue(job, event);

  useEffect(() => {
    if (previousJobIdRef.current !== job.jobId) {
      previousJobIdRef.current = job.jobId;
      setIsExpanded(isActive);
    }
  }, [job.jobId, isActive]);

  return (
    <div className="rounded-[18px] border border-white/10 bg-white/[0.04] p-5 shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Sleep-Cycle Status</p>
          <h3 className="mt-2 text-lg font-semibold text-white">{getSleepCycleStageLabel(job.stage)}</h3>
          <p className="mt-1 text-sm text-neutral-400">
            {job.status === "completed"
              ? summaryLine
              : job.status === "failed"
                ? "The sleep cycle stopped before LTM distillation and graph cleanup completed."
                : `${job.progress}% through MTM consolidation, LTM distillation, and graph cleanup.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={getDocumentStatusBadgeClass(job.status)}>{job.status}</Badge>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-neutral-300 transition-colors hover:border-white/16 hover:bg-white/[0.06]"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "Hide Details" : "Show Details"}
            <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : "rotate-0"}`} />
          </button>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${getDocumentProgressBarClass(job.status)}`} style={{ width: `${progressValue}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.2em] text-neutral-500">
        <span>{updatedAt ? `Updated ${updatedAt}` : getSleepCycleStageLabel(job.stage)}</span>
        <span>{summaryLine}</span>
      </div>

      {isExpanded ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {sleepCycleSteps.map((step) => {
              const stepState = getSleepCycleStepState(job, step.key);

              return (
                <div key={step.key} className={`rounded-[14px] border p-3 ${getDocumentStepCardClass(stepState)}`}>
                  <div className="flex items-center gap-2">
                    {stepState === "complete" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    ) : stepState === "current" ? (
                      <LoaderCircle className="h-4 w-4 animate-spin text-zinc-300" />
                    ) : stepState === "error" ? (
                      <AlertTriangle className="h-4 w-4 text-rose-300" />
                    ) : (
                      <div className="h-2.5 w-2.5 rounded-full bg-white/20" />
                    )}
                    <p className={`text-sm font-medium ${getDocumentStepTextClass(stepState)}`}>{step.label}</p>
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-[0.2em] text-neutral-500">
                    {stepState === "complete" ? "done" : stepState === "current" ? "active" : stepState === "error" ? "error" : "pending"}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="rounded-[14px] border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Latest activity</p>
                <p className="mt-2 text-sm text-neutral-200">{summaryLine}</p>
              </div>
              {updatedAt ? <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">{updatedAt}</p> : null}
            </div>
            {event?.message && event.message !== summaryLine ? <p className="mt-3 text-sm text-neutral-300">{event.message}</p> : null}
            {job.errorMessage ? <p className="mt-3 text-sm text-rose-300">{job.errorMessage}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PaginationControls({
  page,
  pageSize,
  total,
  itemLabel,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  itemLabel: string;
  onPageChange: (page: number) => Promise<void>;
}) {
  const totalPages = getTotalPages(total, pageSize);
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(total, page * pageSize);

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4 text-sm text-neutral-400 sm:flex-row sm:items-center sm:justify-between">
      <p>{total === 0 ? `No ${itemLabel} available` : `${rangeStart}-${rangeEnd} of ${total} ${itemLabel}`}</p>
      {totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]"
            disabled={page <= 1}
            onClick={() => void onPageChange(page - 1)}
          >
            Previous
          </Button>
          <span className="min-w-[92px] text-center text-[11px] uppercase tracking-[0.22em] text-neutral-500">
            Page {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]"
            disabled={page >= totalPages}
            onClick={() => void onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StmView({
  stm,
  page,
  pageSize,
  query,
  setQuery,
  refreshStm,
}: {
  stm: { entries: EpisodicMemory[]; total: number };
  page: number;
  pageSize: number;
  query: string;
  setQuery: (value: string) => void;
  refreshStm: (page?: number, query?: string) => Promise<void>;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
      <CardHeader>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Short-Term Memory Knowledge Base</CardTitle>
            <CardDescription className="text-neutral-400">Deterministic PostgreSQL view of imported chunks and live episodic rows</CardDescription>
          </div>
          <form
            className="flex gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void refreshStm(1, query);
            }}
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by content"
              className="border-white/10 bg-neutral-900/50 text-neutral-100"
            />
            <Button type="submit" variant="outline" className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]">
              Apply
            </Button>
          </form>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-[16px] border border-white/10 bg-neutral-950/36">
          <table className="min-w-full divide-y divide-white/10 text-sm">
            <thead className="bg-neutral-950/70 text-neutral-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Actor</th>
                <th className="px-4 py-3 text-left font-medium">Session</th>
                <th className="px-4 py-3 text-left font-medium">Source</th>
                <th className="px-4 py-3 text-left font-medium">Content</th>
                <th className="px-4 py-3 text-left font-medium">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 bg-white/[0.03]">
              {stm.entries.length > 0 ? (
                stm.entries.map((entry) => (
                  <tr key={entry.interactionId} className="transition-colors hover:bg-white/[0.04]">
                    <td className="px-4 py-3"><Badge className="bg-white/10 text-neutral-100">{entry.actor}</Badge></td>
                    <td className="px-4 py-3 text-neutral-300">{entry.sessionId}</td>
                    <td className="px-4 py-3 text-neutral-400">{entry.sourceType ?? "conversation"}</td>
                    <td className="px-4 py-3 text-neutral-200">{entry.rawText.slice(0, 160)}</td>
                    <td className="px-4 py-3 text-neutral-400">{new Date(entry.timestamp).toLocaleString()}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                    No STM entries match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationControls
          page={page}
          pageSize={pageSize}
          total={stm.total}
          itemLabel="STM rows"
          onPageChange={(nextPage) => refreshStm(nextPage, query)}
        />
      </CardContent>
    </Card>
  );
}

function MtmView({ graph }: { graph: GraphSnapshot }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-5">
        {[
          { label: "Nodes", value: graph.stats.nodeCount },
          { label: "Annotated Nodes", value: graph.stats.annotatedNodeCount },
          { label: "Edges", value: graph.stats.edgeCount },
          { label: "Overlap Edges", value: graph.stats.overlapEdgeCount },
          { label: "Communities", value: graph.stats.communityCount },
        ].map((card) => (
          <Card key={card.label} className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
            <CardHeader>
              <CardDescription className="text-neutral-400">{card.label}</CardDescription>
              <CardTitle className="text-3xl">{card.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>Medium-Term Memory Network</CardTitle>
          <CardDescription className="text-neutral-400">A bounded episodic graph enriched by extracted semantic attributes on nodes and shared semantic overlap on similarity edges. The graph can be panned, zoomed, and expanded into fullscreen for inspection.</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <MtmGraph graph={graph} />
        </CardContent>
      </Card>
    </div>
  );
}

function LtmView({
  ltm,
  page,
  pageSize,
  refreshLtm,
}: {
  ltm: { facts: SemanticFact[]; total: number };
  page: number;
  pageSize: number;
  refreshLtm: (page?: number) => Promise<void>;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
      <CardHeader>
        <CardTitle>Long-Term Memory Fact Store</CardTitle>
        <CardDescription className="text-neutral-400">pgvector-backed semantic facts distilled from MTM communities with vector fingerprints for validation</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ltm.facts.length > 0 ? (
          ltm.facts.map((fact) => (
            <div key={fact.knowledgeId} className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4 transition-colors hover:border-white/16 hover:bg-neutral-950/72">
              <div className="flex items-start justify-between gap-3">
                <p className="text-base font-medium text-white">{fact.distilledFact}</p>
                <Badge className="bg-white/10 text-neutral-100">{fact.provenance?.length ?? 0} sources</Badge>
              </div>
              <div className="mt-3 rounded-[14px] border border-white/10 bg-neutral-950/55 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={fact.embeddingSummary.dimensions > 0 ? "bg-emerald-300/90 text-emerald-950" : "bg-rose-300/90 text-rose-950"}>
                    {fact.embeddingSummary.dimensions > 0 ? `${fact.embeddingSummary.dimensions}-dim vector` : "Vector unavailable"}
                  </Badge>
                  <span className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">SHA-256 fingerprint</span>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-neutral-300">{fact.embeddingSummary.checksum}</p>
              </div>
              <p className="mt-2 text-sm text-neutral-400">Last accessed {new Date(fact.lastAccessed).toLocaleString()}</p>
            </div>
          ))
        ) : (
          <div className="rounded-[16px] border border-dashed border-white/10 bg-neutral-950/30 px-4 py-10 text-center text-sm text-neutral-400">
            No distilled LTM facts are available yet.
          </div>
        )}
        <PaginationControls
          page={page}
          pageSize={pageSize}
          total={ltm.total}
          itemLabel="LTM facts"
          onPageChange={(nextPage) => refreshLtm(nextPage)}
        />
      </CardContent>
    </Card>
  );
}

function JobsView({ jobs, events }: { jobs: JobRecord[]; events: PipelineEvent[] }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>Pipeline Jobs</CardTitle>
          <CardDescription className="text-neutral-400">Tracked ingestion and consolidation runs</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {jobs.map((job) => (
            <div key={job.jobId} className="rounded-[16px] border border-white/10 bg-neutral-900/50 p-4 transition-colors hover:border-white/16 hover:bg-neutral-950/72">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-white">{job.jobType}</p>
                  <p className="text-xs uppercase tracking-[0.24em] text-neutral-500">{job.stage}</p>
                </div>
                <Badge className="bg-white/10 text-neutral-100">{job.status}</Badge>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-white" style={{ width: `${job.progress}%` }} />
              </div>
              {job.errorMessage ? <p className="mt-3 text-sm text-rose-300">{job.errorMessage}</p> : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
        <CardHeader>
          <CardTitle>Pipeline Event Timeline</CardTitle>
          <CardDescription className="text-neutral-400">Chronological stream of document and consolidation activity</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[720px] pr-4">
            <div className="space-y-4">
              {events.map((event) => (
                <div key={event.eventId} className="relative rounded-[16px] border border-white/10 bg-neutral-900/50 p-4 transition-colors hover:border-white/16 hover:bg-neutral-950/72">
                  <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-neutral-500">
                    <Badge className="bg-white/10 text-neutral-100">{event.stage}</Badge>
                    {event.level}
                  </div>
                  <p className="font-medium text-white">{event.message}</p>
                  <p className="mt-2 text-sm text-neutral-400">{new Date(event.createdAt).toLocaleString()}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

type ConversationHookCodeTab = "python" | "nodejs" | "curl";

const PYTHON_SNIPPET = `import requests

MEMORY_API = "http://localhost:3000/api/v1/integration"
API_KEY = "your-api-key"  # omit header if auth disabled

def push_message(session_id: str, actor: str, text: str):
    resp = requests.post(
        f"{MEMORY_API}/chat-logs",
        json={"sessionId": session_id, "actor": actor, "rawText": text},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    resp.raise_for_status()
    return resp.json()

def push_conversation(session_id: str, messages: list[dict]):
    logs = [{"actor": m["role"], "rawText": m["content"]} for m in messages]
    resp = requests.post(
        f"{MEMORY_API}/chat-logs/batch",
        json={"sessionId": session_id, "logs": logs},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    resp.raise_for_status()
    return resp.json()`;

const NODEJS_SNIPPET = `const MEMORY_API = 'http://localhost:3000/api/v1/integration';
const API_KEY = 'your-api-key'; // omit if auth disabled

async function pushMessage(sessionId, actor, rawText) {
  const res = await fetch(\`\${MEMORY_API}/chat-logs\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${API_KEY}\`,
    },
    body: JSON.stringify({ sessionId, actor, rawText }),
  });
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}

async function pushConversation(sessionId, messages) {
  const logs = messages.map(m => ({ actor: m.role, rawText: m.content }));
  const res = await fetch(\`\${MEMORY_API}/chat-logs/batch\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${API_KEY}\`,
    },
    body: JSON.stringify({ sessionId, logs }),
  });
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}`;

const CURL_SNIPPET = `# Single message
curl -X POST http://localhost:3000/api/v1/integration/chat-logs \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer your-api-key" \\
  -d '{
    "sessionId": "session-abc123",
    "actor": "user",
    "rawText": "What is the capital of France?",
    "sourceApp": "my-chatbot"
  }'

# Batch messages
curl -X POST http://localhost:3000/api/v1/integration/chat-logs/batch \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer your-api-key" \\
  -d '{
    "sessionId": "session-abc123",
    "sourceApp": "my-chatbot",
    "logs": [
      {"actor": "user", "rawText": "What is the capital of France?"},
      {"actor": "agent", "rawText": "The capital of France is Paris."}
    ]
  }'`;

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative rounded-[14px] border border-white/10 bg-gray-900">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">{language}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-neutral-300 transition-colors hover:border-white/16 hover:bg-white/[0.08]"
          onClick={handleCopy}
        >
          <Copy className="h-3 w-3" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed text-gray-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ConversationHookView() {
  const [activeTab, setActiveTab] = useState<ConversationHookCodeTab>("python");
  const [testSessionId, setTestSessionId] = useState("test-session-001");
  const [testActor, setTestActor] = useState("user");
  const [testText, setTestText] = useState("Hello, this is a test message from the memory engine console.");
  const [testResult, setTestResult] = useState<{ ok: true; interactionId: string } | { ok: false; message: string } | null>(null);
  const [testPending, setTestPending] = useState(false);

  const handleSendTest = async () => {
    setTestPending(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/v1/integration/chat-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: testSessionId, actor: testActor, rawText: testText }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
        setTestResult({ ok: false, message });
      } else {
        setTestResult({ ok: true, interactionId: String(data.interactionId ?? data.id ?? "—") });
      }
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : "Network error" });
    } finally {
      setTestPending(false);
    }
  };

  const codeTabItems: { key: ConversationHookCodeTab; label: string }[] = [
    { key: "python", label: "Python" },
    { key: "nodejs", label: "Node.js" },
    { key: "curl", label: "curl" },
  ];

  const codeByTab: Record<ConversationHookCodeTab, { code: string; language: string }> = {
    python: { code: PYTHON_SNIPPET, language: "python" },
    nodejs: { code: NODEJS_SNIPPET, language: "javascript" },
    curl: { code: CURL_SNIPPET, language: "bash" },
  };

  return (
    <div className="space-y-8">

      {/* Section 1: How it works */}
      <div>
        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-neutral-500">How it works</p>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              step: "1",
              title: "Chat logs come in",
              body: "Your LLM app posts individual messages or full conversation batches to the integration API. Each message is stamped with a session ID and actor role.",
            },
            {
              step: "2",
              title: "Stored as STM episodes",
              body: "Each log entry is written into the Short-Term Memory base as an episodic interaction row, preserving the raw text, actor, session context, and optional metadata.",
            },
            {
              step: "3",
              title: "Consolidated during sleep cycle",
              body: "When you trigger the sleep-cycle, STM episodes are projected into the MTM graph, clustered into communities, and distilled into the LTM semantic fact store.",
            },
          ].map((card) => (
            <div key={card.step} className="rounded-[16px] border border-white/10 bg-white/[0.04] p-5">
              <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-xs font-semibold text-neutral-300">
                {card.step}
              </div>
              <p className="font-medium text-white">{card.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">{card.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: Authentication */}
      <div>
        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-neutral-500">Authentication</p>
        <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-5 space-y-4">
          <p className="text-sm leading-relaxed text-neutral-300">
            Set the <code className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-neutral-100">INTEGRATION_API_KEYS</code> environment variable on the server to one or more comma-separated keys. When the variable is present, every request to the integration endpoints must supply a matching key.
          </p>
          <div className="rounded-[14px] border border-white/10 bg-gray-900 px-4 py-3">
            <p className="font-mono text-sm text-gray-100">Authorization: Bearer &lt;your-api-key&gt;</p>
          </div>
          <div className="rounded-[14px] border border-zinc-300/20 bg-zinc-300/[0.06] px-4 py-3">
            <p className="text-sm text-neutral-300">
              <span className="font-medium text-white">Dev mode:</span> if <code className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-neutral-100">INTEGRATION_API_KEYS</code> is not set, the endpoint accepts unauthenticated requests. The live test panel below uses this behaviour.
            </p>
          </div>
        </div>
      </div>

      {/* Section 3: Endpoint Reference */}
      <div>
        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-neutral-500">Endpoint Reference</p>
        <div className="grid gap-4 xl:grid-cols-2">
          {/* Single message */}
          <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-5 space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Badge className="bg-white/10 text-neutral-100">POST</Badge>
                <code className="font-mono text-sm text-neutral-200">
                  /api/v1/integration/chat-logs
                </code>
              </div>
              <p className="mt-2 text-sm text-neutral-400">Submit a single interaction to the STM base.</p>
            </div>
            <div className="rounded-[14px] border border-white/10 bg-gray-900 p-4">
              <pre className="overflow-x-auto text-xs leading-relaxed text-gray-100">{`{
  "sessionId":             "string (required)",
  "actor":                 "user | agent | system",
  "rawText":               "string (required, max 5120 chars)",
  "externalMessageId":     "string (optional)",
  "externalTimestamp":     "ISO 8601 string (optional)",
  "sourceApp":             "string (optional)",
  "agentId":               "string (optional)",
  "namespace":             "string (optional)",
  "externalConversationId":"string (optional)",
  "metadata":              "object (optional)"
}`}</pre>
            </div>
          </div>

          {/* Batch messages */}
          <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-5 space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <Badge className="bg-white/10 text-neutral-100">POST</Badge>
                <code className="font-mono text-sm text-neutral-200">
                  /api/v1/integration/chat-logs/batch
                </code>
              </div>
              <p className="mt-2 text-sm text-neutral-400">Submit 1–200 log entries in a single request.</p>
            </div>
            <div className="rounded-[14px] border border-white/10 bg-gray-900 p-4">
              <pre className="overflow-x-auto text-xs leading-relaxed text-gray-100">{`{
  "sessionId":  "string (required)",
  "sourceApp":  "string (optional)",
  "logs": [
    {
      "actor":              "user | agent | system",
      "rawText":            "string (required)",
      "externalMessageId":  "string (optional)",
      "externalTimestamp":  "ISO 8601 string (optional)"
    }
  ]
}`}</pre>
            </div>
          </div>
        </div>
      </div>

      {/* Section 4: Integration Examples */}
      <div>
        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-neutral-500">Integration Examples</p>
        <div className="rounded-[16px] border border-white/10 bg-white/[0.04] overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-white/10">
            {codeTabItems.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`px-5 py-3 text-sm transition-colors ${activeTab === tab.key
                    ? "border-b-2 border-zinc-300 text-white"
                    : "text-neutral-400 hover:text-neutral-200"
                  }`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="p-5">
            <CodeBlock code={codeByTab[activeTab].code} language={codeByTab[activeTab].language} />
          </div>
        </div>
      </div>

      {/* Section 5: Verify your setup */}
      <div>
        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-neutral-500">Verify Your Setup</p>
        <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-5 space-y-4">
          <p className="text-sm text-neutral-400">
            Send a test message directly from this console. The request goes to the local server with no <code className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-neutral-100">Authorization</code> header, so it works whenever the server is running in dev mode.
          </p>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-xs uppercase tracking-[0.22em] text-neutral-500">Session ID</p>
                  <Input
                    value={testSessionId}
                    onChange={(e) => setTestSessionId(e.target.value)}
                    placeholder="test-session-001"
                    className="border-white/10 bg-neutral-900/50 text-neutral-100"
                  />
                </div>
                <div>
                  <p className="mb-1.5 text-xs uppercase tracking-[0.22em] text-neutral-500">Actor</p>
                  <select
                    value={testActor}
                    onChange={(e) => setTestActor(e.target.value)}
                    className="h-10 w-full rounded-md border border-white/10 bg-neutral-900/50 px-3 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-zinc-300/40"
                  >
                    <option value="user">user</option>
                    <option value="agent">agent</option>
                    <option value="system">system</option>
                  </select>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs uppercase tracking-[0.22em] text-neutral-500">Message Text</p>
                <textarea
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-white/10 bg-neutral-900/50 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-zinc-300/40 resize-none"
                  placeholder="Enter a test message..."
                />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              className="bg-zinc-300 text-neutral-950 hover:bg-zinc-200"
              disabled={testPending || !testSessionId.trim() || !testText.trim()}
              onClick={() => void handleSendTest()}
            >
              {testPending ? (
                <>
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Send Test Message
                </>
              )}
            </Button>
            {testResult ? (
              testResult.ok ? (
                <div className="flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                  <span>Stored — interaction ID: <code className="font-mono text-xs">{testResult.interactionId}</code></span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-full border border-rose-300/30 bg-rose-300/10 px-4 py-2 text-sm text-rose-200">
                  <AlertTriangle className="h-4 w-4 text-rose-300" />
                  {testResult.message}
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}