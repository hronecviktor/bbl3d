<script lang="ts">
  import { app, current } from "../state.svelte";
  import Chart from "./Chart.svelte";
  import { DEFAULT_PANELS, PRESETS } from "./presets";

  interface Panel {
    id: number;
    preset: string; // preset id or "custom"
    fields: string[];
  }

  const f = $derived(current.flight!);
  let nextId = 0;
  const panelFor = (preset: string): Panel => ({
    id: nextId++,
    preset,
    fields: [...(PRESETS.find((p) => p.id === preset)?.fields ?? [])],
  });
  let panels: Panel[] = $state(DEFAULT_PANELS.map(panelFor));
  let xRange: [number, number] | null = $state(null);
  let height = $state(Math.round(window.innerHeight * 0.38));

  // usable presets for this log (at least one field logged)
  const presets = $derived(PRESETS.filter((p) => p.fields.some((n) => f.has(n))));
  const allFields = $derived(f.fieldNames.filter((n) => n !== "time" && n !== "loopIteration"));

  // keep the playhead in view while playing zoomed in
  $effect(() => {
    const t = app.t;
    if (!xRange || !app.playing) return;
    const [a, b] = xRange;
    if (t > b || t < a) {
      const w = b - a;
      xRange = [Math.max(0, t - w * 0.25), Math.max(0, t - w * 0.25) + w];
    }
  });

  function setPreset(p: Panel, id: string) {
    p.preset = id;
    p.fields = [...(PRESETS.find((x) => x.id === id)?.fields ?? p.fields)];
  }

  function startResize(e: PointerEvent) {
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev: PointerEvent) => (height = Math.min(window.innerHeight * 0.8, Math.max(120, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<section class="charts" style="height: {height}px">
  <div class="grip" role="separator" aria-label="Resize charts" onpointerdown={startResize}></div>
  <div class="toolbar">
    <span class="hint">Drag to zoom · double-click to reset · click to seek</span>
    {#if xRange}<button onclick={() => (xRange = null)}>Reset zoom</button>{/if}
    <button onclick={() => (panels = [...panels, panelFor("pitch")])}>+ Chart</button>
  </div>
  <div class="panels">
    {#each panels as p (p.id)}
      <div class="panel">
        <div class="ptools">
          <select value={p.preset} onchange={(e) => setPreset(p, e.currentTarget.value)} aria-label="Preset">
            {#each presets as pr}<option value={pr.id}>{pr.label}</option>{/each}
            <option value="custom">Custom</option>
          </select>
          <select
            value=""
            aria-label="Add field"
            onchange={(e) => {
              const v = e.currentTarget.value;
              if (v && !p.fields.includes(v)) {
                p.fields = [...p.fields, v];
                p.preset = "custom";
              }
              e.currentTarget.value = "";
            }}
          >
            <option value="">+ field</option>
            {#each allFields as n}<option value={n}>{n}</option>{/each}
          </select>
          {#each p.fields as n}
            <button
              class="chip"
              title="Remove {n}"
              onclick={() => {
                p.fields = p.fields.filter((x) => x !== n);
                p.preset = "custom";
              }}>{n} ×</button
            >
          {/each}
          <span class="spacer"></span>
          {#if panels.length > 1}
            <button class="close" aria-label="Remove chart" onclick={() => (panels = panels.filter((x) => x !== p))}>×</button>
          {/if}
        </div>
        <div class="plot">
          <Chart flight={f} fields={p.fields} {xRange} onzoom={(r) => (xRange = r)} />
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .charts {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-top: 1px solid var(--line);
    min-height: 120px;
  }
  .grip {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 8px;
    cursor: ns-resize;
    z-index: 3;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 10px;
  }
  .hint {
    flex: 1;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .panels {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 140px;
    border-top: 1px solid var(--line);
  }
  .ptools {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 3px 10px;
    flex-wrap: wrap;
    font-size: 0.8rem;
  }
  .ptools select {
    font-size: 0.8rem;
  }
  .chip {
    font-size: 0.72rem;
    padding: 0 6px;
  }
  .spacer {
    flex: 1;
  }
  .plot {
    flex: 1;
    min-height: 0;
    padding: 0 6px;
  }
</style>
