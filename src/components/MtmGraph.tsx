import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as d3 from "d3";
import { Expand, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

import type { GraphSnapshot } from "../lib/memoryService";

// Derive bipartite types from GraphSnapshot to avoid additional imports
type TopicNodeRecord = GraphSnapshot["topicNodes"][number];
type MentionsEdge = GraphSnapshot["mentionEdges"][number];

// --- Discriminated union node types ---

type ChunkRenderNode = GraphSnapshot["nodes"][number] & { nodeKind: "chunk" } & d3.SimulationNodeDatum;
type TopicRenderNode = TopicNodeRecord & { nodeKind: "topic"; nodeId: string; displayLabel: string } & d3.SimulationNodeDatum;
type RenderNode = ChunkRenderNode | TopicRenderNode;

// --- Discriminated union link types ---

type SimilarRenderLink = GraphSnapshot["edges"][number] & { edgeKind: "similar" } & d3.SimulationLinkDatum<RenderNode>;
type MentionsRenderLink = MentionsEdge & { edgeKind: "mentions"; source: string; target: string; weight: number } & d3.SimulationLinkDatum<RenderNode>;
type RenderLink = SimilarRenderLink | MentionsRenderLink;

// --- Inspector types ---

type InspectorNeighbor = GraphSnapshot["nodes"][number] & {
  weight: number;
  edgeType: GraphSnapshot["edges"][number]["type"];
  cosineWeight: number;
  semanticOverlapWeight: number;
  sharedEntityCount: number;
  sharedEntities: GraphSnapshot["edges"][number]["sharedEntities"];
};

type TopicMention = {
  topicId: string;
  entityType: string;
  canonicalName: string;
  confidence: number;
};

type ChunkInspectorNode = GraphSnapshot["nodes"][number] & {
  nodeKind: "chunk";
  degree: number;
  weightedDegree: number;
  neighbors: InspectorNeighbor[];
  mentionedTopics: TopicMention[];
};

type TopicInspectorNode = TopicNodeRecord & {
  nodeKind: "topic";
  nodeId: string;
  displayLabel: string;
  degree: number;
  weightedDegree: number;
  mentioningChunkIds: string[];
};

type InspectorNode = ChunkInspectorNode | TopicInspectorNode;

// --- Type guards ---

function isTopicNode(n: RenderNode): n is TopicRenderNode {
  return n.nodeKind === "topic";
}

function isChunkNode(n: RenderNode): n is ChunkRenderNode {
  return n.nodeKind === "chunk";
}

function isTopicInspectorNode(n: InspectorNode): n is TopicInspectorNode {
  return n.nodeKind === "topic";
}

function isChunkInspectorNode(n: InspectorNode): n is ChunkInspectorNode {
  return n.nodeKind === "chunk";
}

// --- Constants ---

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

const entityTypeColors: Record<string, string> = {
  PERSON: "rgba(251, 113, 133, 0.85)",
  CONCEPT: "rgba(167, 243, 208, 0.85)",
  ORGANIZATION: "rgba(196, 181, 253, 0.85)",
  LOCATION: "rgba(253, 224, 71, 0.85)",
  EVENT: "rgba(251, 191, 36, 0.85)",
  TECHNOLOGY: "rgba(125, 211, 252, 0.85)",
};

function entityTypeColor(entityType: string): string {
  return entityTypeColors[entityType] ?? "rgba(203, 213, 225, 0.85)";
}

interface MtmGraphProps {
  graph: GraphSnapshot;
}

export default function MtmGraph({ graph }: MtmGraphProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const zoomTransformRef = useRef(d3.zoomIdentity);
  const fitTransformRef = useRef(d3.zoomIdentity);
  const lastGraphKeyRef = useRef("");
  const [viewport, setViewport] = useState({ width: 1200, height: 680 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const nodeInspectorData = useMemo(() => buildNodeInspectorData(graph), [graph]);
  const selectedNode = selectedNodeId ? nodeInspectorData.get(selectedNodeId) ?? null : null;

  useEffect(() => {
    if (selectedNodeId && !nodeInspectorData.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [nodeInspectorData, selectedNodeId]);

  useEffect(() => {
    if (!frameRef.current) {
      return;
    }

    const element = frameRef.current;
    const updateViewport = () => {
      const rect = element.getBoundingClientRect();
      setViewport({
        width: Math.max(680, Math.floor(rect.width)),
        height: Math.max(isFullscreen ? 780 : 620, Math.floor(rect.height)),
      });
    };

    updateViewport();

    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [isFullscreen]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const nextIsFullscreen = document.fullscreenElement === frameRef.current;
      setIsFullscreen(nextIsFullscreen);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const width = viewport.width;
    const height = viewport.height;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    svg.attr("preserveAspectRatio", "xMidYMid meet");

    // SVG defs — arrowhead marker for MENTIONS edges
    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "arrow-mentions")
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("refX", 5)
      .attr("refY", 3)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0 L0,6 L6,3 z")
      .attr("fill", "rgba(167,243,208,0.7)");

    const color = d3.scaleOrdinal(d3.schemeTableau10);

    // Only render topic nodes that are referenced by a visible mention edge
    const visibleTopicIds = new Set(graph.mentionEdges.map((e) => e.topicId));
    const filteredTopicNodes = graph.topicNodes.filter((t) => visibleTopicIds.has(t.topicId));

    // Build unified node list — chunks first, then topics
    const chunkRenderNodes: RenderNode[] = graph.nodes.map((node) => ({ ...node, nodeKind: "chunk" as const }));
    const topicRenderNodes: RenderNode[] = filteredTopicNodes.map((t) => ({
      ...t,
      nodeKind: "topic" as const,
      nodeId: t.topicId,
      displayLabel: t.canonicalName,
    }));
    const nodes: RenderNode[] = [...chunkRenderNodes, ...topicRenderNodes];

    // Build unified link list
    const similarLinks: RenderLink[] = graph.edges.map((edge) => ({ ...edge, edgeKind: "similar" as const }));
    const mentionsLinks: RenderLink[] = graph.mentionEdges
      .filter((e) => visibleTopicIds.has(e.topicId))
      .map((e) => ({
        ...e,
        edgeKind: "mentions" as const,
        source: e.chunkId,
        target: e.topicId,
        weight: e.confidence,
      }));
    const links: RenderLink[] = [...similarLinks, ...mentionsLinks];

    seedNodePositions(nodes, width, height);

    const graphLayer = svg.append("g").attr("data-layer", "graph");

    const simulation = d3
      .forceSimulation<RenderNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<RenderNode, RenderLink>(links)
          .id((datum) => datum.nodeId)
          .distance((d) => {
            if (d.edgeKind === "mentions") return 70;
            return 88 - Math.min(42, d.weight * 28);
          })
      )
      .force("charge", d3.forceManyBody<RenderNode>().strength((d) => (d.nodeKind === "topic" ? -180 : -320)))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collision",
        d3.forceCollide<RenderNode>().radius((d) => {
          if (d.nodeKind === "topic") return 14 + Math.min(d.mentionCount, 30) * 0.6;
          return 16 + (d.pageRank ?? 0) * 24;
        })
      );

    // SIMILAR_TO edges rendered first (below MENTIONS arcs)
    const similarLinkElements = graphLayer
      .append("g")
      .attr("data-sublayer", "similar-links")
      .selectAll("line")
      .data(links.filter((d): d is SimilarRenderLink => d.edgeKind === "similar"))
      .enter()
      .append("line")
      .attr("stroke", (datum) => getBaseLinkStroke(datum))
      .attr("stroke-opacity", (datum) => (datum.type === "SIMILAR_TO" ? 1 : 0.92))
      .attr("stroke-dasharray", (datum) => getLinkDashArray(datum) ?? null)
      .attr("stroke-width", (datum) => getLinkWidth(datum));

    // MENTIONS arcs with arrowheads
    const mentionsLinkElements = graphLayer
      .append("g")
      .attr("data-sublayer", "mentions-links")
      .selectAll("line")
      .data(links.filter((d): d is MentionsRenderLink => d.edgeKind === "mentions"))
      .enter()
      .append("line")
      .attr("stroke", "rgba(167, 243, 208, 0.35)")
      .attr("stroke-opacity", 1)
      .attr("stroke-dasharray", "4 3")
      .attr("stroke-width", (datum) => 0.6 + datum.confidence * 1.2)
      .attr("marker-end", "url(#arrow-mentions)");

    // Node groups
    const node = graphLayer
      .append("g")
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("cursor", "pointer")
      .on("click", (event, datum) => {
        event.stopPropagation();
        setSelectedNodeId((current) => (current === datum.nodeId ? null : datum.nodeId));
      });

    const drag = d3
      .drag<SVGGElement, RenderNode>()
      .on("start", (event, datum) => {
        if (!event.active) {
          simulation.alphaTarget(0.22).restart();
        }
        datum.fx = datum.x;
        datum.fy = datum.y;
      })
      .on("drag", (event, datum) => {
        datum.fx = event.x;
        datum.fy = event.y;
      })
      .on("end", (event, datum) => {
        if (!event.active) {
          simulation.alphaTarget(0);
        }
        datum.fx = null;
        datum.fy = null;
      });

    node.call(drag);

    // Chunk nodes: circle
    node
      .filter((d): d is ChunkRenderNode => d.nodeKind === "chunk")
      .append("circle")
      .classed("node-shape", true)
      .attr("r", (datum) => getNodeRadius(datum))
      .attr("fill", (datum) => getNodeFill(datum, color))
      .attr("stroke", (datum) => getNodeStroke(datum))
      .attr("stroke-width", 1.5);

    // Topic nodes: diamond (rotated rect centered at origin)
    node
      .filter((d): d is TopicRenderNode => d.nodeKind === "topic")
      .append("rect")
      .classed("node-shape", true)
      .attr("width", (datum) => getTopicNodeRadius(datum) * 1.9)
      .attr("height", (datum) => getTopicNodeRadius(datum) * 1.9)
      .attr("x", (datum) => -(getTopicNodeRadius(datum) * 1.9) / 2)
      .attr("y", (datum) => -(getTopicNodeRadius(datum) * 1.9) / 2)
      .attr("transform", "rotate(45)")
      .attr("fill", (datum) => entityTypeColor(datum.entityType))
      .attr("stroke", "rgba(255,255,255,0.35)")
      .attr("stroke-width", 1.5);

    // Tooltips
    node.append("title").text((datum) => `${datum.nodeId}\n${datum.displayLabel}`);

    // Chunk node labels
    node
      .filter((d): d is ChunkRenderNode => d.nodeKind === "chunk")
      .append("text")
      .text((datum) => truncateContent(datum.displayLabel, datum.type === "semantic" ? 20 : 26))
      .attr("font-size", (datum) => (datum.type === "semantic" ? 9 : 10))
      .attr("fill", "#f8fafc")
      .attr("text-anchor", "middle")
      .attr("dy", 3)
      .attr("pointer-events", "none");

    // Topic node labels
    node
      .filter((d): d is TopicRenderNode => d.nodeKind === "topic")
      .append("text")
      .text((datum) => truncateContent(datum.canonicalName, 14))
      .attr("font-size", 8)
      .attr("fill", "#f8fafc")
      .attr("text-anchor", "middle")
      .attr("dy", 3)
      .attr("pointer-events", "none");

    const renderPositions = () => {
      similarLinkElements
        .attr("x1", (datum) => (datum.source as RenderNode).x ?? 0)
        .attr("y1", (datum) => (datum.source as RenderNode).y ?? 0)
        .attr("x2", (datum) => (datum.target as RenderNode).x ?? 0)
        .attr("y2", (datum) => (datum.target as RenderNode).y ?? 0);

      mentionsLinkElements
        .attr("x1", (datum) => (datum.source as RenderNode).x ?? 0)
        .attr("y1", (datum) => (datum.source as RenderNode).y ?? 0)
        .attr("x2", (datum) => (datum.target as RenderNode).x ?? 0)
        .attr("y2", (datum) => (datum.target as RenderNode).y ?? 0);

      node.attr("transform", (datum) => `translate(${datum.x ?? 0},${datum.y ?? 0})`);
    };

    const applySelectionState = () => {
      const connectedNodeIds = new Set<string>();
      const selectedSimilarLinks = new Set<SimilarRenderLink>();
      const selectedMentionsLinks = new Set<MentionsRenderLink>();

      if (selectedNodeId) {
        connectedNodeIds.add(selectedNodeId);

        const selectedRenderNode = nodes.find((n) => n.nodeId === selectedNodeId);
        const selectedIsChunk = selectedRenderNode ? isChunkNode(selectedRenderNode) : false;
        const selectedIsTopic = selectedRenderNode ? isTopicNode(selectedRenderNode) : false;

        links.forEach((datum) => {
          const sourceId =
            typeof datum.source === "string" ? datum.source : (datum.source as RenderNode).nodeId;
          const targetId =
            typeof datum.target === "string" ? datum.target : (datum.target as RenderNode).nodeId;

          if (datum.edgeKind === "similar") {
            // Chunk selected: highlight SIMILAR_TO neighbors (unchanged behavior)
            if (selectedIsChunk && (sourceId === selectedNodeId || targetId === selectedNodeId)) {
              connectedNodeIds.add(sourceId);
              connectedNodeIds.add(targetId);
              selectedSimilarLinks.add(datum);
            }
          } else {
            // Chunk selected: highlight outbound MENTIONS arcs and their topic targets
            if (selectedIsChunk && sourceId === selectedNodeId) {
              connectedNodeIds.add(targetId);
              selectedMentionsLinks.add(datum);
            }
            // Topic selected: highlight inbound MENTIONS arcs and their chunk sources
            if (selectedIsTopic && targetId === selectedNodeId) {
              connectedNodeIds.add(sourceId);
              connectedNodeIds.add(targetId);
              selectedMentionsLinks.add(datum);
            }
          }
        });
      }

      similarLinkElements
        .attr("stroke", (datum) => {
          if (!selectedNodeId) return getBaseLinkStroke(datum);
          return selectedSimilarLinks.has(datum) ? getHighlightedLinkStroke(datum) : "rgba(148, 163, 184, 0.12)";
        })
        .attr("stroke-opacity", (datum) => {
          if (!selectedNodeId) return datum.type === "SIMILAR_TO" ? 1 : 0.92;
          return selectedSimilarLinks.has(datum) ? 1 : 0.45;
        })
        .attr("stroke-dasharray", (datum) => getLinkDashArray(datum) ?? null)
        .attr("stroke-width", (datum) => {
          const baseWidth = getLinkWidth(datum);
          if (!selectedNodeId) return baseWidth;
          return selectedSimilarLinks.has(datum) ? baseWidth + 1.5 : baseWidth;
        });

      mentionsLinkElements
        .attr("stroke", (datum) => {
          if (!selectedNodeId) return "rgba(167, 243, 208, 0.35)";
          return selectedMentionsLinks.has(datum) ? "rgba(167, 243, 208, 0.85)" : "rgba(148, 163, 184, 0.08)";
        })
        .attr("stroke-opacity", 1)
        .attr("stroke-width", (datum) => {
          const baseWidth = 0.6 + datum.confidence * 1.2;
          if (!selectedNodeId) return baseWidth;
          return selectedMentionsLinks.has(datum) ? baseWidth + 1.5 : baseWidth;
        });

      node
        .select(".node-shape")
        .attr("opacity", (datum) => {
          if (!selectedNodeId) return 1;
          return connectedNodeIds.has(datum.nodeId) ? 1 : 0.38;
        })
        .attr("stroke", (datum) => {
          if (datum.nodeId === selectedNodeId) {
            return "rgba(248, 250, 252, 0.95)";
          }
          if (selectedNodeId && connectedNodeIds.has(datum.nodeId)) {
            if (isTopicNode(datum)) return "rgba(167, 243, 208, 0.85)";
            return datum.type === "semantic" ? "rgba(250, 204, 21, 0.85)" : "rgba(125, 211, 252, 0.75)";
          }
          return isTopicNode(datum) ? "rgba(255,255,255,0.35)" : getNodeStroke(datum);
        })
        .attr("stroke-width", (datum) => (datum.nodeId === selectedNodeId ? 3 : 1.5));

      node
        .select("text")
        .attr("opacity", (datum) => {
          if (!selectedNodeId) return 1;
          return connectedNodeIds.has(datum.nodeId) ? 1 : 0.4;
        })
        .attr("font-size", (datum) => {
          if (datum.nodeId === selectedNodeId) return 11;
          return isTopicNode(datum) ? 8 : 10;
        })
        .attr("font-weight", (datum) => (datum.nodeId === selectedNodeId ? 600 : 400));

      if (selectedNodeId) {
        node.filter((datum) => datum.nodeId === selectedNodeId).raise();
      }
    };

    simulation.stop();

    const settleTicks = Math.min(420, Math.max(160, nodes.length * 10 + links.length * 2));
    for (let index = 0; index < settleTicks; index += 1) {
      simulation.tick();
    }

    renderPositions();
    applySelectionState();

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      .on("zoom", (event) => {
        zoomTransformRef.current = event.transform;
        setZoomScale(event.transform.k);
        graphLayer.attr("transform", event.transform.toString());
      });

    zoomBehaviorRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    const graphSignature = createGraphSignature(graph);
    const nextFitTransform = calculateFitTransform(nodes, width, height, links.length);
    const shouldRefit =
      lastGraphKeyRef.current !== graphSignature ||
      transformsAreClose(zoomTransformRef.current, fitTransformRef.current);

    fitTransformRef.current = nextFitTransform;
    if (shouldRefit) {
      zoomTransformRef.current = nextFitTransform;
      setZoomScale(nextFitTransform.k);
    }
    lastGraphKeyRef.current = graphSignature;

    svg.call(zoomBehavior.transform, zoomTransformRef.current);

    simulation.alpha(0.08).restart();
    simulation.on("tick", renderPositions);

    return () => {
      simulation.stop();
    };
  }, [graph, selectedNodeId, viewport]);

  const adjustZoom = (direction: "in" | "out") => {
    if (!svgRef.current || !zoomBehaviorRef.current) {
      return;
    }

    const svg = d3.select(svgRef.current);
    const scaleDelta = direction === "in" ? 1.2 : 0.82;
    svg.transition().duration(180).call(zoomBehaviorRef.current.scaleBy as any, scaleDelta);
  };

  const resetZoom = () => {
    if (!svgRef.current || !zoomBehaviorRef.current) {
      return;
    }

    const svg = d3.select(svgRef.current);
    svg.transition().duration(180).call(zoomBehaviorRef.current.transform as any, fitTransformRef.current);
  };

  const toggleFullscreen = async () => {
    if (!frameRef.current) {
      return;
    }

    if (document.fullscreenElement === frameRef.current) {
      await document.exitFullscreen();
      return;
    }

    await frameRef.current.requestFullscreen();
  };

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-[620px] items-center justify-center rounded-[20px] border border-white/10 bg-black/80 text-sm text-neutral-400">
        No MTM nodes available yet.
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      className={`relative overflow-hidden rounded-[20px] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.14),_rgba(2,6,23,0.96)_55%)] ${isFullscreen ? "h-[88vh]" : "h-[620px] xl:h-[720px]"
        }`}
    >
      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex items-start justify-between gap-4">
        <div className="pointer-events-auto rounded-full border border-white/10 bg-black/65 px-3 py-1.5 text-[11px] uppercase tracking-[0.24em] text-neutral-300 backdrop-blur">
          Zoom {Math.round(zoomScale * 100)}%
        </div>
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/65 p-1 backdrop-blur">
          <GraphControlButton label="Zoom out" onClick={() => adjustZoom("out")}>
            <ZoomOut className="h-4 w-4" />
          </GraphControlButton>
          <GraphControlButton label="Reset zoom" onClick={resetZoom}>
            <RotateCcw className="h-4 w-4" />
          </GraphControlButton>
          <GraphControlButton label="Zoom in" onClick={() => adjustZoom("in")}>
            <ZoomIn className="h-4 w-4" />
          </GraphControlButton>
          <GraphControlButton label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => void toggleFullscreen()}>
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
          </GraphControlButton>
        </div>
      </div>

      <div className="pointer-events-none absolute left-4 top-16 z-10 flex max-w-[70%] flex-wrap gap-2">
        <LegendPill label="Episodic / Chunk Nodes" className="border-sky-300/30 bg-sky-400/10 text-sky-100" />
        <LegendPill label="Topic Nodes" className="border-violet-300/30 bg-violet-400/10 text-violet-100" />
        <LegendPill label="Similarity Edges" className="border-sky-300/20 bg-sky-500/10 text-sky-100" />
        <LegendPill label="Overlap-Enriched Edges" className="border-amber-300/20 bg-amber-500/10 text-amber-100" />
        <LegendPill label="Mentions Arcs" className="border-emerald-300/20 bg-emerald-500/10 text-emerald-100" />
      </div>

      <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-full border border-white/10 bg-black/65 px-3 py-1.5 text-[11px] uppercase tracking-[0.24em] text-neutral-400 backdrop-blur">
        Drag canvas to pan. Scroll to zoom. Click nodes to inspect episodic clusters, extracted semantic anchors, and shared overlap.
      </div>

      <div className="absolute inset-x-4 bottom-4 z-10 md:inset-x-auto md:right-4 md:w-[360px]">
        <NodeInspector selectedNode={selectedNode} onClear={() => setSelectedNodeId(null)} onSelectNeighbor={setSelectedNodeId} />
      </div>

      <svg ref={svgRef} className="h-full w-full" />
    </div>
  );
}

function NodeInspector({
  selectedNode,
  onClear,
  onSelectNeighbor,
}: {
  selectedNode: InspectorNode | null;
  onClear: () => void;
  onSelectNeighbor: (nodeId: string) => void;
}) {
  return (
    <div className="pointer-events-auto flex max-h-[min(72vh,36rem)] flex-col overflow-hidden rounded-[20px] border border-white/10 bg-black/70 p-4 shadow-[0_18px_50px_rgba(2,6,23,0.32)] backdrop-blur-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-400">Node Inspector</p>
          <p className="mt-1 text-sm text-neutral-200">
            {selectedNode
              ? "Inspect content, extracted semantic anchors, salience, and strongest local overlap links."
              : "Select a node to inspect its memory payload, semantic anchors, and shared overlap."}
          </p>
        </div>
        {selectedNode ? (
          <button
            type="button"
            aria-label="Clear selected node"
            title="Clear selected node"
            onClick={onClear}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-neutral-300 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {selectedNode ? (
        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
          {isTopicInspectorNode(selectedNode) ? (
            <TopicInspectorPanel node={selectedNode} onSelectNeighbor={onSelectNeighbor} />
          ) : (
            <ChunkInspectorPanel node={selectedNode} onSelectNeighbor={onSelectNeighbor} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function TopicInspectorPanel({
  node,
  onSelectNeighbor,
}: {
  node: TopicInspectorNode;
  onSelectNeighbor: (nodeId: string) => void;
}) {
  return (
    <>
      <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-neutral-300">
            Topic Node
          </span>
          <span className="rounded-full border border-violet-300/20 bg-violet-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-violet-200">
            {node.entityType}
          </span>
        </div>
        <p className="mt-3 break-all font-mono text-[11px] text-neutral-500">{node.topicId}</p>
        <p className="mt-2 text-sm leading-6 text-neutral-100">{node.canonicalName}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm text-neutral-300">
        <MetricPill label="Entity Type" value={node.entityType} />
        <MetricPill label="Mention Count" value={String(node.mentionCount)} />
        <MetricPill label="Confidence" value={formatDecimal(node.confidence, 2)} />
        <MetricPill label="Last Mentioned" value={formatTimestamp(node.lastMentionedAt)} />
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">Mentioned by Chunks</p>
        {node.mentioningChunkIds.length > 0 ? (
          <div className="mt-2 space-y-2">
            {node.mentioningChunkIds.slice(0, 5).map((chunkId) => (
              <button
                key={chunkId}
                type="button"
                onClick={() => onSelectNeighbor(chunkId)}
                className="flex w-full items-start rounded-[14px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.08]"
              >
                <p className="break-all font-mono text-[11px] text-neutral-300">{truncateContent(chunkId, 40)}</p>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">No chunks mention this topic in the current snapshot.</p>
        )}
      </div>
    </>
  );
}

function ChunkInspectorPanel({
  node,
  onSelectNeighbor,
}: {
  node: ChunkInspectorNode;
  onSelectNeighbor: (nodeId: string) => void;
}) {
  return (
    <>
      <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-neutral-300">
            {node.type}
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-neutral-300">
            Community {node.communityId ?? "-"}
          </span>
          <span className="rounded-full border border-amber-300/20 bg-amber-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-amber-100">
            {node.semanticEntityCount} anchors
          </span>
        </div>
        <p className="mt-3 break-all font-mono text-[11px] text-neutral-500">{node.nodeId}</p>
        <p className="mt-2 text-sm leading-6 text-neutral-100">{node.content}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm text-neutral-300">
        <MetricPill label="PageRank" value={formatDecimal(node.pageRank ?? 0, 3)} />
        <MetricPill label="Connections" value={String(node.degree)} />
        <MetricPill label="Weighted Degree" value={formatDecimal(node.weightedDegree, 2)} />
        <MetricPill label="Anchors" value={String(node.semanticEntityCount)} />
        <MetricPill label="Consolidated" value={formatTimestamp(node.consolidatedAt)} />
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">Extracted Semantic Anchors</p>
        {node.semanticEntities.length > 0 ? (
          <div className="mt-2 space-y-2">
            {node.semanticEntities.slice(0, 6).map((entity) => (
              <div
                key={`${node.nodeId}:${entity.entityId}`}
                className="rounded-[14px] border border-white/10 bg-white/[0.04] px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-neutral-100">{entity.canonicalName}</p>
                  <span className="rounded-full border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-amber-100">
                    {entity.entityType}
                  </span>
                  <span className="rounded-full border border-white/10 bg-black/35 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-neutral-300">
                    {formatEdgeType(entity.relationshipType)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-neutral-500">
                  Confidence {formatDecimal(entity.confidence, 2)}
                </p>
                {entity.relationshipHint ? (
                  <p className="mt-1 text-[11px] leading-5 text-neutral-500">{entity.relationshipHint}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">No extracted semantic anchors were stored on this episodic node.</p>
        )}
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">Strongest Linked Nodes</p>
        {node.neighbors.length > 0 ? (
          <div className="mt-2 space-y-2">
            {node.neighbors.slice(0, 5).map((neighbor) => (
              <button
                key={neighbor.nodeId}
                type="button"
                onClick={() => onSelectNeighbor(neighbor.nodeId)}
                className="flex w-full items-start justify-between gap-3 rounded-[14px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.08]"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-neutral-100">{truncateContent(neighbor.displayLabel, 64)}</p>
                    <span className="rounded-full border border-white/10 bg-black/35 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-neutral-300">
                      Similarity
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-neutral-500">{truncateContent(neighbor.nodeId, 28)}</p>
                  {neighbor.sharedEntityCount > 0 ? (
                    <p className="mt-1 text-[11px] leading-5 text-neutral-500">
                      Shared anchors: {neighbor.sharedEntities.slice(0, 4).map((entity) => entity.canonicalName).join(", ")}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] leading-5 text-neutral-500">
                    Cosine {formatDecimal(neighbor.cosineWeight, 2)} • Semantic overlap {formatDecimal(neighbor.semanticOverlapWeight, 2)}
                  </p>
                </div>
                <span className="rounded-full border border-white/10 bg-black/35 px-2 py-1 font-mono text-[11px] text-neutral-300">
                  {formatDecimal(neighbor.weight, 2)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">No linked nodes are visible in the current MTM snapshot.</p>
        )}
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">Mentions Topics</p>
        {node.mentionedTopics.length > 0 ? (
          <div className="mt-2 space-y-2">
            {node.mentionedTopics.map((topic) => (
              <button
                key={topic.topicId}
                type="button"
                onClick={() => onSelectNeighbor(topic.topicId)}
                className="flex w-full items-start justify-between gap-3 rounded-[14px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.08]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-neutral-100">{topic.canonicalName}</p>
                  <span className="rounded-full border border-white/10 bg-black/35 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-neutral-300">
                    {topic.entityType}
                  </span>
                </div>
                <span className="rounded-full border border-white/10 bg-black/35 px-2 py-1 font-mono text-[11px] text-neutral-300">
                  {formatDecimal(topic.confidence, 2)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">No topic mentions recorded for this chunk.</p>
        )}
      </div>
    </>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-white/10 bg-white/[0.04] px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">{label}</p>
      <p className="mt-1 text-sm text-neutral-100">{value}</p>
    </div>
  );
}

function buildNodeInspectorData(graph: GraphSnapshot): Map<string, InspectorNode> {
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const detailsById = new Map<string, InspectorNode>();

  // Build chunk inspector nodes (existing traversal logic)
  graph.nodes.forEach((node) => {
    const chunkNode: ChunkInspectorNode = {
      ...node,
      nodeKind: "chunk",
      degree: 0,
      weightedDegree: 0,
      neighbors: [],
      mentionedTopics: [],
    };
    detailsById.set(node.nodeId, chunkNode);
  });

  graph.edges.forEach((edge) => {
    const source = detailsById.get(edge.source);
    const target = detailsById.get(edge.target);
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);

    if (!source || !target || !sourceNode || !targetNode) {
      return;
    }
    if (!isChunkInspectorNode(source) || !isChunkInspectorNode(target)) {
      return;
    }

    source.degree += 1;
    target.degree += 1;
    source.weightedDegree += edge.weight;
    target.weightedDegree += edge.weight;
    source.neighbors.push({
      ...targetNode,
      weight: edge.weight,
      edgeType: edge.type,
      cosineWeight: edge.cosineWeight,
      semanticOverlapWeight: edge.semanticOverlapWeight,
      sharedEntityCount: edge.sharedEntityCount,
      sharedEntities: edge.sharedEntities,
    });
    target.neighbors.push({
      ...sourceNode,
      weight: edge.weight,
      edgeType: edge.type,
      cosineWeight: edge.cosineWeight,
      semanticOverlapWeight: edge.semanticOverlapWeight,
      sharedEntityCount: edge.sharedEntityCount,
      sharedEntities: edge.sharedEntities,
    });
  });

  // Build topic inspector nodes (only those with visible mention edges)
  const topicById = new Map(graph.topicNodes.map((t) => [t.topicId, t]));
  const visibleTopicIds = new Set(graph.mentionEdges.map((e) => e.topicId));

  graph.topicNodes
    .filter((t) => visibleTopicIds.has(t.topicId))
    .forEach((topic) => {
      const topicNode: TopicInspectorNode = {
        ...topic,
        nodeKind: "topic",
        nodeId: topic.topicId,
        displayLabel: topic.canonicalName,
        degree: 0,
        weightedDegree: 0,
        mentioningChunkIds: [],
      };
      detailsById.set(topic.topicId, topicNode);
    });

  // Populate mention relationships in both directions
  graph.mentionEdges.forEach((edge) => {
    const chunkInspector = detailsById.get(edge.chunkId);
    const topicInspector = detailsById.get(edge.topicId);
    const topicRecord = topicById.get(edge.topicId);

    if (chunkInspector && isChunkInspectorNode(chunkInspector) && topicRecord) {
      chunkInspector.mentionedTopics.push({
        topicId: edge.topicId,
        entityType: topicRecord.entityType,
        canonicalName: topicRecord.canonicalName,
        confidence: edge.confidence,
      });
    }

    if (topicInspector && isTopicInspectorNode(topicInspector)) {
      topicInspector.mentioningChunkIds.push(edge.chunkId);
      topicInspector.degree += 1;
      topicInspector.weightedDegree += edge.confidence;
    }
  });

  // Sort chunk neighbors by descending weight
  detailsById.forEach((node) => {
    if (isChunkInspectorNode(node)) {
      node.neighbors.sort((left, right) => right.weight - left.weight);
    }
  });

  return detailsById;
}

function seedNodePositions(nodes: RenderNode[], width: number, height: number) {
  if (nodes.length === 0) {
    return;
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(width, height) * 0.16;

  const chunkNodes = nodes.filter(isChunkNode);
  const topicNodes = nodes.filter(isTopicNode);

  if (chunkNodes.length === 1) {
    chunkNodes[0].x = centerX;
    chunkNodes[0].y = centerY;
  } else {
    chunkNodes.forEach((node, index) => {
      const angle = (index / chunkNodes.length) * Math.PI * 2;
      const ring = Math.floor(index / 12);
      const radius = baseRadius + ring * 40 + (index % 3) * 8;

      node.x = centerX + Math.cos(angle) * radius;
      node.y = centerY + Math.sin(angle) * radius;
    });
  }

  const outerRadius = baseRadius * 2.2;
  topicNodes.forEach((node, index) => {
    const angle = (index / Math.max(1, topicNodes.length)) * Math.PI * 2;
    node.x = centerX + Math.cos(angle) * outerRadius;
    node.y = centerY + Math.sin(angle) * outerRadius;
  });
}

function calculateFitTransform(nodes: RenderNode[], width: number, height: number, edgeCount: number) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  nodes.forEach((node) => {
    const radius = isTopicNode(node) ? getTopicNodeRadius(node) : getNodeRadius(node);
    const x = node.x ?? width / 2;
    const y = node.y ?? height / 2;

    minX = Math.min(minX, x - radius);
    maxX = Math.max(maxX, x + radius);
    minY = Math.min(minY, y - radius);
    maxY = Math.max(maxY, y + radius);
  });

  const graphWidth = Math.max(120, maxX - minX);
  const graphHeight = Math.max(120, maxY - minY);
  const density = edgeCount / Math.max(nodes.length, 1);
  const padding = Math.min(Math.min(width, height) * 0.18, 64 + nodes.length * 1.35 + density * 18);

  let scale = Math.min((width - padding * 2) / graphWidth, (height - padding * 2) / graphHeight);
  scale = Math.max(MIN_SCALE, Math.min(scale, nodes.length <= 6 ? 1.3 : 1.08));

  if (density > 2) {
    scale *= Math.max(0.84, 1 - (density - 2) * 0.045);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return d3.zoomIdentity.translate(width / 2 - centerX * scale, height / 2 - centerY * scale).scale(scale);
}

function createGraphSignature(graph: GraphSnapshot) {
  return [
    graph.nodes.map((node) => `${node.nodeId}:${node.type}:${node.displayLabel}`).join("|"),
    graph.edges.map((edge) => `${edge.source}:${edge.target}:${edge.type}:${edge.weight.toFixed(3)}`).join("|"),
    `tn:${graph.topicNodes.length}`,
    `me:${graph.mentionEdges.length}`,
  ].join("::");
}

function transformsAreClose(left: d3.ZoomTransform, right: d3.ZoomTransform) {
  return Math.abs(left.k - right.k) < 0.001 && Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5;
}

function getTopicNodeRadius(node: { mentionCount: number }) {
  return 9 + Math.min(node.mentionCount, 30) * 0.55;
}

function getNodeRadius(node: { pageRank?: number }) {
  return 12 + Math.max(0, (node.pageRank ?? 0) * 16);
}

function truncateContent(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function formatDecimal(value: number, digits: number) {
  return value.toFixed(digits);
}

function getNodeFill(node: GraphSnapshot["nodes"][number], communityColor: d3.ScaleOrdinal<string, string>) {
  return communityColor(String(node.communityId ?? -1));
}

function getNodeStroke(_node: GraphSnapshot["nodes"][number]) {
  return "rgba(226, 232, 240, 0.28)";
}

function getBaseLinkStroke(link: GraphSnapshot["edges"][number]) {
  return link.sharedEntityCount > 0 ? "rgba(251, 191, 36, 0.42)" : "rgba(125, 211, 252, 0.22)";
}

function getHighlightedLinkStroke(link: GraphSnapshot["edges"][number]) {
  return link.sharedEntityCount > 0 ? "rgba(251, 191, 36, 0.88)" : "rgba(125, 211, 252, 0.82)";
}

function getLinkWidth(link: GraphSnapshot["edges"][number]) {
  return 0.8 + link.cosineWeight * 1.5 + link.semanticOverlapWeight * 1.4;
}

function getLinkDashArray(link: GraphSnapshot["edges"][number]) {
  return link.sharedEntityCount > 0 ? "6 4" : undefined;
}

function formatEdgeType(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

function LegendPill({ label, className }: { label: string; className: string }) {
  return <span className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.24em] ${className}`}>{label}</span>;
}

function GraphControlButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-neutral-200 transition-colors hover:border-white/10 hover:bg-white/[0.08] hover:text-white"
    >
      {children}
    </button>
  );
}
