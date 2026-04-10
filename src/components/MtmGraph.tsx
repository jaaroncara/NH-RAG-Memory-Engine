import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as d3 from "d3";
import { Expand, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

import type { GraphSnapshot } from "../lib/memoryService";

type RenderNode = GraphSnapshot["nodes"][number] & d3.SimulationNodeDatum;
type RenderLink = GraphSnapshot["edges"][number] & d3.SimulationLinkDatum<RenderNode>;
type InspectorNeighbor = GraphSnapshot["nodes"][number] & {
  weight: number;
  edgeType: GraphSnapshot["edges"][number]["type"];
  cosineWeight: number;
  semanticOverlapWeight: number;
  sharedEntityCount: number;
  sharedEntities: GraphSnapshot["edges"][number]["sharedEntities"];
};
type InspectorNode = GraphSnapshot["nodes"][number] & {
  degree: number;
  weightedDegree: number;
  neighbors: InspectorNeighbor[];
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

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

    const color = d3.scaleOrdinal(d3.schemeTableau10);
    const nodes: RenderNode[] = graph.nodes.map((node) => ({ ...node }));
    const links: RenderLink[] = graph.edges.map((edge) => ({ ...edge }));

  seedNodePositions(nodes, width, height);

    const graphLayer = svg.append("g").attr("data-layer", "graph");

    const simulation = d3
      .forceSimulation<RenderNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<RenderNode, RenderLink>(links)
          .id((datum) => datum.nodeId)
          .distance((datum) => 88 - Math.min(42, datum.weight * 28))
      )
      .force("charge", d3.forceManyBody<RenderNode>().strength(-320))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide<RenderNode>().radius((datum) => 16 + (datum.pageRank ?? 0) * 24));

    const link = graphLayer
      .append("g")
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", (datum) => getBaseLinkStroke(datum))
      .attr("stroke-opacity", (datum) => (datum.type === "SIMILAR_TO" ? 1 : 0.92))
      .attr("stroke-dasharray", (datum) => getLinkDashArray(datum))
      .attr("stroke-width", (datum) => getLinkWidth(datum));

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

    node
      .append("circle")
      .attr("r", (datum) => getNodeRadius(datum))
      .attr("fill", (datum) => getNodeFill(datum, color))
      .attr("stroke", (datum) => getNodeStroke(datum))
      .attr("stroke-width", 1.5);

    node
      .append("title")
      .text((datum) => `${datum.nodeId}\n${datum.displayLabel}`);

    node
      .append("text")
      .text((datum) => truncateContent(datum.displayLabel, datum.type === "semantic" ? 20 : 26))
      .attr("font-size", (datum) => (datum.type === "semantic" ? 9 : 10))
      .attr("fill", "#f8fafc")
      .attr("text-anchor", "middle")
      .attr("dy", 3)
      .attr("pointer-events", "none");

    const renderPositions = () => {
      link
        .attr("x1", (datum) => (datum.source as RenderNode).x ?? 0)
        .attr("y1", (datum) => (datum.source as RenderNode).y ?? 0)
        .attr("x2", (datum) => (datum.target as RenderNode).x ?? 0)
        .attr("y2", (datum) => (datum.target as RenderNode).y ?? 0);

      node.attr("transform", (datum) => `translate(${datum.x ?? 0},${datum.y ?? 0})`);
    };

    const applySelectionState = () => {
      const connectedNodeIds = new Set<string>();
      const selectedLinks = new Set<RenderLink>();

      if (selectedNodeId) {
        connectedNodeIds.add(selectedNodeId);
        links.forEach((datum) => {
          const sourceId = typeof datum.source === "string" ? datum.source : datum.source.nodeId;
          const targetId = typeof datum.target === "string" ? datum.target : datum.target.nodeId;

          if (sourceId === selectedNodeId || targetId === selectedNodeId) {
            connectedNodeIds.add(sourceId);
            connectedNodeIds.add(targetId);
            selectedLinks.add(datum);
          }
        });
      }

      link
        .attr("stroke", (datum) => {
          if (!selectedNodeId) {
            return getBaseLinkStroke(datum);
          }
          return selectedLinks.has(datum) ? getHighlightedLinkStroke(datum) : "rgba(148, 163, 184, 0.12)";
        })
        .attr("stroke-opacity", (datum) => {
          if (!selectedNodeId) {
            return datum.type === "SIMILAR_TO" ? 1 : 0.92;
          }
          return selectedLinks.has(datum) ? 1 : 0.45;
        })
        .attr("stroke-dasharray", (datum) => getLinkDashArray(datum))
        .attr("stroke-width", (datum) => {
          const baseWidth = getLinkWidth(datum);
          if (!selectedNodeId) {
            return baseWidth;
          }
          return selectedLinks.has(datum) ? baseWidth + 1.5 : baseWidth;
        });

      node
        .select("circle")
        .attr("opacity", (datum) => {
          if (!selectedNodeId) {
            return 1;
          }
          return connectedNodeIds.has(datum.nodeId) ? 1 : 0.38;
        })
        .attr("stroke", (datum) => {
          if (datum.nodeId === selectedNodeId) {
            return "rgba(248, 250, 252, 0.95)";
          }
          if (selectedNodeId && connectedNodeIds.has(datum.nodeId)) {
            return datum.type === "semantic" ? "rgba(250, 204, 21, 0.85)" : "rgba(125, 211, 252, 0.75)";
          }
          return getNodeStroke(datum);
        })
        .attr("stroke-width", (datum) => (datum.nodeId === selectedNodeId ? 3 : 1.5));

      node
        .select("text")
        .attr("opacity", (datum) => {
          if (!selectedNodeId) {
            return 1;
          }
          return connectedNodeIds.has(datum.nodeId) ? 1 : 0.4;
        })
        .attr("font-size", (datum) => (datum.nodeId === selectedNodeId ? 11 : 10))
        .attr("font-weight", (datum) => (datum.nodeId === selectedNodeId ? 600 : 400));

      if (selectedNodeId) {
        node.filter((datum) => datum.nodeId === selectedNodeId).raise();
      }
    };

    simulation.stop();

    const settleTicks = Math.min(420, Math.max(160, graph.nodes.length * 10 + graph.edges.length * 2));
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
    const shouldRefit = lastGraphKeyRef.current !== graphSignature || transformsAreClose(zoomTransformRef.current, fitTransformRef.current);

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
      className={`relative overflow-hidden rounded-[20px] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.14),_rgba(2,6,23,0.96)_55%)] ${
        isFullscreen ? "h-[88vh]" : "h-[620px] xl:h-[720px]"
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
        <LegendPill label="Episodic Nodes" className="border-sky-300/30 bg-sky-400/10 text-sky-100" />
        <LegendPill label="Similarity Edges" className="border-sky-300/20 bg-sky-500/10 text-sky-100" />
        <LegendPill label="Overlap-Enriched Edges" className="border-amber-300/20 bg-amber-500/10 text-amber-100" />
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
            {selectedNode ? "Inspect content, extracted semantic anchors, salience, and strongest local overlap links." : "Select a node to inspect its memory payload, semantic anchors, and shared overlap."}
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
          <div className="rounded-[16px] border border-white/10 bg-white/[0.04] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-neutral-300">
                {selectedNode.type}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-neutral-300">
                Community {selectedNode.communityId ?? "-"}
              </span>
              <span className="rounded-full border border-amber-300/20 bg-amber-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.22em] text-amber-100">
                {selectedNode.semanticEntityCount} anchors
              </span>
            </div>
            <p className="mt-3 break-all font-mono text-[11px] text-neutral-500">{selectedNode.nodeId}</p>
            <p className="mt-2 text-sm leading-6 text-neutral-100">{selectedNode.content}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm text-neutral-300">
            <MetricPill label="PageRank" value={formatDecimal(selectedNode.pageRank ?? 0, 3)} />
            <MetricPill label="Connections" value={String(selectedNode.degree)} />
            <MetricPill label="Weighted Degree" value={formatDecimal(selectedNode.weightedDegree, 2)} />
            <MetricPill label="Anchors" value={String(selectedNode.semanticEntityCount)} />
            <MetricPill label="Consolidated" value={formatTimestamp(selectedNode.consolidatedAt)} />
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">Extracted Semantic Anchors</p>
            {selectedNode.semanticEntities.length > 0 ? (
              <div className="mt-2 space-y-2">
                {selectedNode.semanticEntities.slice(0, 6).map((entity) => (
                  <div
                    key={`${selectedNode.nodeId}:${entity.entityId}`}
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
            {selectedNode.neighbors.length > 0 ? (
              <div className="mt-2 space-y-2">
                {selectedNode.neighbors.slice(0, 5).map((neighbor) => (
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
        </div>
      ) : null}
    </div>
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

function buildNodeInspectorData(graph: GraphSnapshot) {
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const detailsById = new Map<string, InspectorNode>();

  graph.nodes.forEach((node) => {
    detailsById.set(node.nodeId, {
      ...node,
      degree: 0,
      weightedDegree: 0,
      neighbors: [],
    });
  });

  graph.edges.forEach((edge) => {
    const source = detailsById.get(edge.source);
    const target = detailsById.get(edge.target);
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);

    if (!source || !target || !sourceNode || !targetNode) {
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

  detailsById.forEach((node) => {
    node.neighbors.sort((left, right) => right.weight - left.weight);
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

  if (nodes.length === 1) {
    nodes[0].x = centerX;
    nodes[0].y = centerY;
    return;
  }

  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2;
    const ring = Math.floor(index / 12);
    const radius = baseRadius + ring * 40 + (index % 3) * 8;

    node.x = centerX + Math.cos(angle) * radius;
    node.y = centerY + Math.sin(angle) * radius;
  });
}

function calculateFitTransform(nodes: RenderNode[], width: number, height: number, edgeCount: number) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  nodes.forEach((node) => {
    const radius = getNodeRadius(node);
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
  ].join("::");
}

function transformsAreClose(left: d3.ZoomTransform, right: d3.ZoomTransform) {
  return Math.abs(left.k - right.k) < 0.001 && Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5;
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