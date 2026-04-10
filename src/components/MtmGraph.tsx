import { useEffect, useRef, useState, type ReactNode } from "react";
import * as d3 from "d3";
import { Expand, Minimize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import type { GraphSnapshot } from "../lib/memoryService";

type RenderNode = GraphSnapshot["nodes"][number] & d3.SimulationNodeDatum;
type RenderLink = GraphSnapshot["edges"][number] & d3.SimulationLinkDatum<RenderNode>;

interface MtmGraphProps {
  graph: GraphSnapshot;
}

export default function MtmGraph({ graph }: MtmGraphProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const zoomTransformRef = useRef(d3.zoomIdentity);
  const [viewport, setViewport] = useState({ width: 1200, height: 680 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);

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
      .attr("stroke", "rgba(125, 211, 252, 0.22)")
      .attr("stroke-width", 1)
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke-width", (datum) => 1 + datum.weight * 2.5);

    const node = graphLayer
      .append("g")
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g");

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
      .attr("r", (datum) => 12 + Math.max(0, (datum.pageRank ?? 0) * 16))
      .attr("fill", (datum) => color(String(datum.communityId ?? -1)))
      .attr("stroke", "rgba(226, 232, 240, 0.28)")
      .attr("stroke-width", 1.5);

    node
      .append("title")
      .text((datum) => `${datum.nodeId}\n${datum.content}`);

    node
      .append("text")
      .text((datum) => `${datum.content.slice(0, 26)}${datum.content.length > 26 ? "…" : ""}`)
      .attr("font-size", 10)
      .attr("fill", "#f8fafc")
      .attr("text-anchor", "middle")
      .attr("dy", 3)
      .attr("pointer-events", "none");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.55, 4])
      .on("zoom", (event) => {
        zoomTransformRef.current = event.transform;
        setZoomScale(event.transform.k);
        graphLayer.attr("transform", event.transform.toString());
      });

    zoomBehaviorRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, zoomTransformRef.current);

    simulation.on("tick", () => {
      link
        .attr("x1", (datum) => (datum.source as RenderNode).x ?? 0)
        .attr("y1", (datum) => (datum.source as RenderNode).y ?? 0)
        .attr("x2", (datum) => (datum.target as RenderNode).x ?? 0)
        .attr("y2", (datum) => (datum.target as RenderNode).y ?? 0);

      node.attr("transform", (datum) => `translate(${datum.x ?? 0},${datum.y ?? 0})`);
    });

    return () => {
      simulation.stop();
    };
  }, [graph, viewport]);

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
    svg.transition().duration(180).call(zoomBehaviorRef.current.transform as any, d3.zoomIdentity);
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

      <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-full border border-white/10 bg-black/65 px-3 py-1.5 text-[11px] uppercase tracking-[0.24em] text-neutral-400 backdrop-blur">
        Drag canvas to pan. Scroll or use controls to zoom.
      </div>

      <svg ref={svgRef} className="h-full w-full" />
    </div>
  );
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