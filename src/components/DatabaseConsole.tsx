import { useEffect, useRef, useState, useTransition } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Database,
  FileStack,
  GitBranch,
  HardDriveUpload,
  CheckCircle2,
  LoaderCircle,
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
      return "bg-emerald-300";
    case "failed":
      return "bg-rose-300";
    default:
      return "bg-zinc-300";
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
  const [isPending, startTransition] = useTransition();
  const location = useLocation();
  const navigate = useNavigate();
  const hasActiveImports = documents.some((document) => isDocumentImportActive(document.statusSummary.status));
  const previousHasActiveImportsRef = useRef(false);

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
    if (!hasActiveImports) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshDocumentStatus({ silent: true });
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [hasActiveImports, selectedDocument?.documentId]);

  useEffect(() => {
    if (previousHasActiveImportsRef.current && !hasActiveImports) {
      void refreshAll(selectedDocument?.documentId);
    }

    previousHasActiveImportsRef.current = hasActiveImports;
  }, [hasActiveImports, selectedDocument?.documentId]);

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
            MemoryService.listStmEntries({ page: 1, pageSize: 20 }),
            MemoryService.getGraph(),
            MemoryService.listLtmFacts(1, 20),
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
          const result = await MemoryService.runSleepCycle();
          if (result) {
            toast.success(`Sleep-cycle pruned ${result.pruned} nodes and distilled ${result.consolidated} facts`);
          } else {
            toast.info("Not enough MTM nodes for consolidation yet");
          }
          await refreshAll();
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

  const refreshStm = async () => {
    try {
      setStm(await MemoryService.listStmEntries({ page: 1, pageSize: 20, query: stmQuery || undefined }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to filter STM");
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
                    `flex items-center gap-3 rounded-[14px] border px-3 py-3 text-sm transition-all duration-150 ${
                      isActive
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
              <Button className="bg-zinc-300 text-neutral-950 hover:bg-zinc-200" onClick={() => void handleSleepCycle()}>
                <ServerCog className="mr-2 h-4 w-4" />
                Run Sleep-Cycle
              </Button>
            </div>
          </div>

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
                  query={stmQuery}
                  setQuery={setStmQuery}
                  refreshStm={refreshStm}
                />
              }
            />
            <Route path="/mtm" element={<MtmView graph={graph} />} />
            <Route path="/ltm" element={<LtmView ltm={ltm} />} />
            <Route path="/jobs" element={<JobsView jobs={jobs} events={events} />} />
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

              return (
                <button
                  key={document.documentId}
                  type="button"
                  className="w-full rounded-[16px] border border-white/10 bg-neutral-950/40 p-4 text-left transition-all duration-150 hover:border-zinc-300/35 hover:bg-neutral-950/72 active:scale-[0.995]"
                  onClick={() => void openDocument(document.documentId)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-white">{document.filename}</p>
                      <p className="mt-1 text-sm text-neutral-400">{getDocumentStageLabel(summary.stage)} · {summary.progress}%</p>
                    </div>
                    <Badge className={getDocumentStatusBadgeClass(summary.status)}>{summary.status}</Badge>
                  </div>

                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full ${getDocumentProgressBarClass(summary.status)}`} style={{ width: `${getDocumentProgressValue(summary)}%` }} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.2em] text-neutral-500">
                    <span>{updatedAt ? `Updated ${updatedAt}` : getDocumentStageLabel(summary.stage)}</span>
                    {summary.status === "completed" ? <span>{document.chunkCount} chunks</span> : <span>{getDocumentStageLabel(summary.stage)}</span>}
                  </div>

                  <p className={`mt-2 text-sm ${summary.status === "failed" ? "text-rose-300" : "text-neutral-300"}`}>
                    {getDocumentMetaLine(document)}
                  </p>
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
  const updatedAt = formatStatusTimestamp(summary.latestEventAt ?? summary.updatedAt);

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
        <Badge className={getDocumentStatusBadgeClass(summary.status)}>{summary.status}</Badge>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${getDocumentProgressBarClass(summary.status)}`} style={{ width: `${getDocumentProgressValue(summary)}%` }} />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
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

      <div className="mt-4 rounded-[14px] border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">Latest activity</p>
            <p className="mt-2 text-sm text-neutral-200">{summary.latestEventMessage ?? getDocumentMetaLine(document)}</p>
          </div>
          {updatedAt ? <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">{updatedAt}</p> : null}
        </div>
        {summary.errorMessage ? <p className="mt-3 text-sm text-rose-300">{summary.errorMessage}</p> : null}
      </div>
    </div>
  );
}

function StmView({
  stm,
  query,
  setQuery,
  refreshStm,
}: {
  stm: { entries: EpisodicMemory[]; total: number };
  query: string;
  setQuery: (value: string) => void;
  refreshStm: () => Promise<void>;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
      <CardHeader>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Short-Term Memory Knowledge Base</CardTitle>
            <CardDescription className="text-neutral-400">Deterministic PostgreSQL view of imported chunks and live episodic rows</CardDescription>
          </div>
          <div className="flex gap-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by content"
              className="border-white/10 bg-neutral-900/50 text-neutral-100"
            />
            <Button variant="outline" className="border-white/10 bg-white/[0.04] text-neutral-100 hover:bg-white/[0.08]" onClick={() => void refreshStm()}>
              Apply
            </Button>
          </div>
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
              {stm.entries.map((entry) => (
                <tr key={entry.interactionId} className="transition-colors hover:bg-white/[0.04]">
                  <td className="px-4 py-3"><Badge className="bg-white/10 text-neutral-100">{entry.actor}</Badge></td>
                  <td className="px-4 py-3 text-neutral-300">{entry.sessionId}</td>
                  <td className="px-4 py-3 text-neutral-400">{entry.sourceType ?? "conversation"}</td>
                  <td className="px-4 py-3 text-neutral-200">{entry.rawText.slice(0, 160)}</td>
                  <td className="px-4 py-3 text-neutral-400">{new Date(entry.timestamp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-neutral-400">{stm.total} STM rows available</p>
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

function LtmView({ ltm }: { ltm: { facts: SemanticFact[]; total: number } }) {
  return (
    <Card className="border-white/10 bg-white/[0.04] text-neutral-100 shadow-none">
      <CardHeader>
        <CardTitle>Long-Term Memory Fact Store</CardTitle>
        <CardDescription className="text-neutral-400">pgvector-backed semantic facts distilled from MTM communities with vector fingerprints for validation</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ltm.facts.map((fact) => (
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
        ))}
        <p className="pt-2 text-sm text-neutral-400">{ltm.total} LTM facts available</p>
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
                <div className="h-full rounded-full bg-zinc-300" style={{ width: `${job.progress}%` }} />
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

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}