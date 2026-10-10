<script lang="ts">
  import { MODE_LABEL } from "../flight/modes";
  import { app, current } from "../state.svelte";
  import { fmtDuration } from "./format";

  const f = $derived(current.flight!);
  const bands = $derived(f.modes.filter((m) => MODE_COLOR[m.name]));
  const RATES = [0.1, 0.25, 0.5, 1, 2, 4];

  const MODE_COLOR: Record<string, string> = {
    ANGLE: "#3d7bd9",
    HORIZON: "#2aa6a0",
    ALTHOLD: "#6c63d9",
    POSHOLD: "#8b5cd6",
    GPSRESCUE: "#e07b00",
    AUTOPILOT: "#d65c9e",
    FLIPOVERAFTERCRASH: "#b04fd8",
    CRASHFLIP: "#b04fd8",
    FAILSAFE: "#d93a3a",
  };
  const EVENT_COLOR = { arm: "#3cc46a", disarm: "#e5534b", end: "#9aa6b2", resume: "#d9b43d", adjust: "#d9b43d" };

  let bar: HTMLDivElement;
  let scrubbing = false;
  function seekTo(e: PointerEvent) {
    const r = bar.getBoundingClientRect();
    app.t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * f.duration;
  }
  const pct = (t: number) => `${(t / f.duration) * 100}%`;
</script>

<div class="timeline">
  <button
    class="play"
    onclick={() => {
      if (app.t >= f.duration) app.t = 0;
      app.playing = !app.playing;
    }}
    aria-label={app.playing ? "Pause" : "Play"}>{app.playing ? "❚❚" : "▶"}</button
  >
  <span class="time">{fmtDuration(app.t)} / {fmtDuration(f.duration)}</span>
  <select bind:value={app.rate} aria-label="Playback speed">
    {#each RATES as r}<option value={r}>{r}×</option>{/each}
  </select>
  <div
    class="bar"
    bind:this={bar}
    role="slider"
    tabindex="0"
    aria-label="Playback position"
    aria-valuemin={0}
    aria-valuemax={f.duration}
    aria-valuenow={app.t}
    onpointerdown={(e) => {
      scrubbing = true;
      bar.setPointerCapture(e.pointerId);
      seekTo(e);
    }}
    onpointermove={(e) => scrubbing && seekTo(e)}
    onpointerup={() => (scrubbing = false)}
  >
    <div class="track"></div>
    {#each bands as m}
      <div
        class="band"
        style="left: {pct(m.start)}; width: {pct(m.end - m.start)}; background: {MODE_COLOR[m.name]}"
        title="{MODE_LABEL[m.name] ?? m.name} {fmtDuration(m.start)}–{fmtDuration(m.end)}"
      ></div>
    {/each}
    {#each f.events as e}
      <div class="event" style="left: {pct(e.t)}; background: {EVENT_COLOR[e.kind]}" title="{fmtDuration(e.t)} {e.label}"></div>
    {/each}
    {#if f.cutOff}<div class="cut" title="Log ends without a clean log end (power loss, crash or full flash)">cut off</div>{/if}
    <div class="head" style="left: {pct(app.t)}"></div>
  </div>
</div>

<style>
  .timeline {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  .play {
    width: 40px;
  }
  .time {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bar {
    position: relative;
    flex: 1;
    height: 28px;
    cursor: pointer;
    touch-action: none;
  }
  .track {
    position: absolute;
    left: 0;
    right: 0;
    top: 12px;
    height: 4px;
    background: var(--line);
    border-radius: 2px;
  }
  .band {
    position: absolute;
    top: 6px;
    height: 16px;
    opacity: 0.75;
    border-radius: 3px;
  }
  .event {
    position: absolute;
    top: 2px;
    width: 3px;
    height: 24px;
    margin-left: -1px;
    border-radius: 1px;
  }
  .head {
    position: absolute;
    top: 0;
    width: 2px;
    height: 28px;
    background: var(--fg);
    margin-left: -1px;
    pointer-events: none;
  }
  .cut {
    position: absolute;
    right: 0;
    top: -2px;
    font-size: 0.7rem;
    color: var(--warn);
  }
  @media (max-width: 600px) {
    .time {
      display: none;
    }
  }
</style>
