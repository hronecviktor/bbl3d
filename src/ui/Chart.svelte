<script lang="ts">
  import { onMount, untrack } from "svelte";
  import uPlot from "uplot";
  import "uplot/dist/uPlot.min.css";
  import type { Flight } from "../flight/flight";
  import { app } from "../state.svelte";
  import { PALETTE } from "./presets";

  let {
    flight,
    fields,
    xRange,
    onzoom,
  }: {
    flight: Flight;
    fields: string[];
    xRange: [number, number] | null;
    onzoom: (r: [number, number] | null) => void;
  } = $props();

  let el: HTMLDivElement;
  let plot: uPlot | null = null;
  let head = $state(-1);
  let applyingRange = false;

  function build() {
    plot?.destroy();
    const present = fields.filter((n) => flight.has(n));
    const data: uPlot.AlignedData = [flight.t, ...present.map((n) => flight.series(n)!)] as uPlot.AlignedData;
    const units = [...new Set(present.map((n) => flight.unitOf(n)))];
    plot = new uPlot(
      {
        width: el.clientWidth,
        height: el.clientHeight,
        scales: { x: { time: false } },
        legend: { live: true },
        cursor: {
          sync: { key: "bbl3d", setSeries: false },
          drag: { x: true, y: false },
        },
        axes: [
          { stroke: "#8b97a3", grid: { stroke: "#ffffff12" }, values: (_, ticks) => ticks.map((v) => `${v}s`) },
          {
            stroke: "#8b97a3",
            grid: { stroke: "#ffffff12" },
            size: 52,
            label: units.length === 1 ? units[0] : undefined,
            labelSize: 14,
          },
        ],
        series: [
          { label: "t (s)", value: (_, v) => (v == null ? "" : v.toFixed(2)) },
          ...present.map((n, i) => ({
            label: flight.unitOf(n) ? `${n} (${flight.unitOf(n)})` : n,
            stroke: PALETTE[i % PALETTE.length],
            width: 1,
            value: (_: uPlot, v: number | null) => (v == null ? "" : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)),
          })),
        ],
        hooks: {
          setScale: [
            (u, key) => {
              if (key !== "x" || applyingRange) return;
              const { min, max } = u.scales.x;
              const full = min! <= flight.t[0] + 1e-6 && max! >= flight.duration - 1e-6;
              onzoom(full ? null : [min!, max!]);
            },
          ],
          draw: [() => placeHead()],
        },
      },
      data,
      el,
    );
    plot.over.addEventListener("click", () => {
      const left = plot!.cursor.left;
      if (left != null && left >= 0) app.t = plot!.posToVal(left, "x");
    });
    plot.over.addEventListener("dblclick", () => onzoom(null));
    applyRange();
  }

  function applyRange() {
    if (!plot) return;
    applyingRange = true;
    const [min, max] = xRange ?? [flight.t[0], flight.duration];
    plot.setScale("x", { min, max });
    applyingRange = false;
    placeHead();
  }

  function placeHead() {
    if (!plot) return;
    const x = plot.valToPos(app.t, "x");
    head = x >= 0 && x <= plot.bbox.width / devicePixelRatio ? x + plot.bbox.left / devicePixelRatio : -1;
  }

  onMount(() => {
    const ro = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot?.destroy();
    };
  });

  $effect(() => {
    // (re)build when the flight or the field list changes
    void flight;
    void fields.join();
    untrack(build);
  });
  $effect(() => {
    void xRange;
    untrack(applyRange);
  });
  $effect(() => {
    void app.t;
    placeHead();
  });
</script>

<div class="chart" bind:this={el}>
  {#if head >= 0}<div class="head" style="left: {head}px"></div>{/if}
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  .head {
    position: absolute;
    top: 0;
    bottom: 30px;
    width: 1px;
    background: #ffd166;
    pointer-events: none;
    z-index: 3;
  }
  .chart :global(.u-legend) {
    position: absolute;
    top: 2px;
    left: 56px;
    z-index: 2;
    font-size: 11px;
    color: var(--fg);
    background: color-mix(in srgb, var(--panel) 80%, transparent);
    border-radius: 4px;
    text-align: left;
    pointer-events: none;
  }
  .chart :global(.u-legend .u-marker) {
    width: 10px;
    height: 3px;
  }
</style>
