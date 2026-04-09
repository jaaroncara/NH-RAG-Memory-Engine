import { useEffect, useRef } from "react";
import * as d3 from "d3";

import type { GraphSnapshot } from "../lib/memoryService";

interface MtmGraphProps {
  graph: GraphSnapshot;
}

export default function MtmGraph({ graph }: MtmGraphProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();

    const width = 880;
    const height = 420;
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const color = d3.scaleOrdinal(d3.schemeTableau10);
    const nodes = graph.nodes.map((node) => ({ ...node }));
    const links = graph.edges.map((edge) => ({ ...edge }));

    const simulation = d3
      .forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force(
        "link",
        d3.forceLink(links).id((datum: any) => datum.nodeId).distance((datum: any) => 70 - Math.min(40, datum.weight * 20))
      )
      .force("charge", d3.forceManyBody().strength(-220))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((datum: any) => 14 + ((datum.pageRank ?? 0) * 22)));

    const link = svg
      .append("g")
      .attr("stroke", "rgba(125, 211, 252, 0.22)")
      .attr("stroke-width", 1)
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke-width", (datum) => 1 + datum.weight * 2.5);

    const node = svg
      .append("g")
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g");

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
      .text((datum) => datum.content.slice(0, 26))
      .attr("font-size", 10)
      .attr("fill", "#f8fafc")
      .attr("text-anchor", "middle")
      .attr("dy", 3)
      .attr("pointer-events", "none");

    simulation.on("tick", () => {
      link
        .attr("x1", (datum: any) => datum.source.x)
        .attr("y1", (datum: any) => datum.source.y)
        .attr("x2", (datum: any) => datum.target.x)
        .attr("y2", (datum: any) => datum.target.y);

      node.attr("transform", (datum: any) => `translate(${datum.x},${datum.y})`);
    });

    return () => {
      simulation.stop();
    };
  }, [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-[18px] border border-white/10 bg-black/80 text-sm text-neutral-400">
        No MTM nodes available yet.
      </div>
    );
  }

  return <svg ref={ref} className="h-[420px] w-full rounded-[18px] border border-white/10 bg-black/90" />;
}