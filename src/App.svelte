<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Flight } from "./flight/flight";
  import { MapView, type CameraMode } from "./map/mapview";
  import { LogFile } from "./parser/client";
  import { app, current, prefs, savePrefs } from "./state.svelte";
  import Charts from "./ui/Charts.svelte";
  import DropZone from "./ui/DropZone.svelte";
  import Hud from "./ui/Hud.svelte";
  import LogPicker from "./ui/LogPicker.svelte";
  import Settings from "./ui/Settings.svelte";
  import Sticks from "./ui/Sticks.svelte";
  import Timeline from "./ui/Timeline.svelte";

  let mapEl: HTMLDivElement;
  let map: MapView | null = $state(null);
  let file: LogFile | null = null;
  let dragging = $state(false);

  const CAMERAS: { id: CameraMode; label: string; key: string }[] = [
    { id: "chase", label: "Chase", key: "1" },
    { id: "fpv", label: "FPV", key: "2" },
    { id: "orbit", label: "Orbit", key: "3" },
    { id: "top", label: "Top", key: "4" },
  ];

  onMount(() => {
    map = new MapView(mapEl, () => app.t);
    let last = performance.now();
    let raf = requestAnimationFrame(function loop(now) {
      // keep real time on slow renderers; ignore long gaps (hidden tab)
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      const f = current.flight;
      if (app.playing && f) {
        app.t = Math.min(f.duration, app.t + dt * app.rate);
        if (app.t >= f.duration) app.playing = false;
      }
      raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      map?.viewer.destroy();
      file?.dispose();
    };
  });

  // persist prefs whenever any of them changes
  $effect(() => {
    JSON.stringify(prefs);
    savePrefs();
  });

  // map layers follow the map prefs
  $effect(() => {
    const mode = prefs.mapMode;
    const token = prefs.ionToken;
    if (!map) return;
    map.setMapMode(mode, token).then((note) => (app.note = note ?? ""));
  });

  // display smoothing: recompute the pose source and redraw the track
  let appliedSmoothing = -1;
  $effect(() => {
    const level = prefs.smoothing;
    untrack(() => {
      const f = current.flight;
      if (!f || !map || level === appliedSmoothing) return;
      appliedSmoothing = level;
      f.setSmoothing(level);
      map.redraw();
    });
  });

  // camera and view settings
  $effect(() => {
    if (!map) return;
    map.camera = app.camera;
    map.settings = {
      chaseDistance: prefs.chaseDistance,
      chaseHeight: 15,
      fpvUptilt: prefs.fpvUptilt,
      fpvFov: prefs.fpvFov,
    };
  });

  async function openFile(f: File) {
    app.error = "";
    app.loading = `Reading ${f.name}…`;
    try {
      file?.dispose();
      file = new LogFile();
      app.logs = await file.open(await f.arrayBuffer());
      app.fileName = f.name;
      const usable = app.logs.filter((l) => !l.error);
      if (usable.length === 1) await pickLog(usable[0].index);
      else app.pickingLog = true;
    } catch (e) {
      app.error = `Could not read ${f.name}: ${e instanceof Error ? e.message : e}`;
    } finally {
      app.loading = "";
    }
  }

  async function pickLog(index: number) {
    if (!file) return;
    app.pickingLog = false;
    app.loading = `Decoding log ${index + 1}…`;
    app.playing = false;
    try {
      const flight = new Flight(await file.extract(index), app.logs[index]);
      flight.setSmoothing(prefs.smoothing);
      appliedSmoothing = prefs.smoothing;
      current.flight = flight;
      app.t = 0;
      if (!flight.gps) app.note = "This log has no GPS data, so there's no track to show on the map.";
      await map?.setFlight(flight);
    } catch (e) {
      app.error = `Could not decode log ${index + 1}: ${e instanceof Error ? e.message : e}`;
    } finally {
      app.loading = "";
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const f = current.flight;
    const cam = CAMERAS.find((c) => c.key === e.key);
    if (cam) app.camera = cam.id;
    else if (e.key === "c") app.showCharts = !app.showCharts;
    if (!f) return;
    const step = f.duration / Math.max(1, f.t.length - 1);
    const seek = (dt: number) => (app.t = Math.min(f.duration, Math.max(0, app.t + dt)));
    if (e.key === " ") {
      if (app.t >= f.duration) app.t = 0;
      app.playing = !app.playing;
    } else if (e.key === "ArrowRight") seek(e.shiftKey ? 1 : 5);
    else if (e.key === "ArrowLeft") seek(e.shiftKey ? -1 : -5);
    else if (e.key === ".") seek(step);
    else if (e.key === ",") seek(-step);
    else return;
    e.preventDefault();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const f = e.dataTransfer?.files[0];
    if (f) openFile(f);
  }
</script>

<svelte:window
  onkeydown={onKey}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={(e) => {
    if (!e.relatedTarget) dragging = false;
  }}
  ondrop={onDrop}
/>

<div class="app">
  <header>
    <div class="brand">bbl3d</div>
    {#if current.flight}
      <button class="file" onclick={() => (app.pickingLog = true)} title="Pick another log in this file">
        {app.fileName} · log {current.flight.summary.index + 1}/{app.logs.length}
      </button>
    {/if}
    <label class="open">
      Open log…
      <input type="file" accept=".bbl,.bfl,.txt,.BBL,.BFL" onchange={(e) => e.currentTarget.files?.[0] && openFile(e.currentTarget.files[0])} />
    </label>
    <div class="spacer"></div>
    <div class="seg" role="group" aria-label="Camera">
      {#each CAMERAS as c}
        <button class:active={app.camera === c.id} onclick={() => (app.camera = c.id)} title="{c.label} camera ({c.key})">{c.label}</button>
      {/each}
    </div>
    <select bind:value={prefs.mapMode} aria-label="Map">
      <option value="google3d">Google 3D</option>
      <option value="estonia">Open data (EE)</option>
    </select>
    <button class:active={app.showCharts} onclick={() => (app.showCharts = !app.showCharts)} title="Charts (c)">Charts</button>
    <button onclick={() => (app.showSettings = true)} aria-label="Settings">⚙</button>
  </header>

  <main>
    <div class="map" bind:this={mapEl}></div>
    {#if current.flight}
      <Hud />
      <Sticks />
    {/if}
    {#if !current.flight || dragging}
      <DropZone {dragging} onfile={openFile} />
    {/if}
    {#if app.loading}<div class="toast">{app.loading}</div>{/if}
    {#if app.error}
      <div class="toast error">{app.error} <button onclick={() => (app.error = "")}>×</button></div>
    {:else if app.note}
      <div class="toast">{app.note} <button onclick={() => (app.note = "")}>×</button></div>
    {/if}
  </main>

  {#if current.flight}
    <Timeline />
    {#if app.showCharts}<Charts />{/if}
  {/if}
</div>

{#if app.pickingLog}<LogPicker onpick={pickLog} />{/if}
{#if app.showSettings}<Settings />{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--accent);
  }
  .file {
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open {
    position: relative;
    cursor: pointer;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .open input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .spacer {
    flex: 1;
  }
  .seg {
    display: flex;
  }
  .seg button {
    border-radius: 0;
  }
  .seg button:first-child {
    border-radius: 6px 0 0 6px;
  }
  .seg button:last-child {
    border-radius: 0 6px 6px 0;
  }
  main {
    position: relative;
    flex: 1;
    min-height: 200px;
  }
  .map {
    position: absolute;
    inset: 0;
  }
  .toast {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 6px 12px;
    border-radius: 6px;
    max-width: min(90%, 640px);
    z-index: 5;
  }
  .toast.error {
    border-color: var(--bad);
  }
  .toast button {
    margin-left: 8px;
    padding: 0 6px;
  }
</style>
