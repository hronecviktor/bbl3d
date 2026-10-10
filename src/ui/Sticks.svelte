<script lang="ts">
  import { app, current, prefs } from "../state.svelte";

  const f = $derived(current.flight!);
  const i = $derived(f.indexAt(app.t));
  // rcCommand: roll/pitch/yaw in -500..500, throttle in 1000..2000 µs
  const rc = (n: number) => f.raw(`rcCommand[${n}]`)?.[i] ?? 0;
  const roll = $derived(rc(0) / 500);
  const pitch = $derived(rc(1) / 500);
  const yaw = $derived(rc(2) / 500);
  const thr = $derived((rc(3) - 1000) / 500 - 1);

  // Mode 2: left = yaw/throttle, right = roll/pitch. Mode 1: left = yaw/pitch, right = roll/throttle.
  const left = $derived(prefs.stickMode === 2 ? { x: yaw, y: thr } : { x: yaw, y: pitch });
  const right = $derived(prefs.stickMode === 2 ? { x: roll, y: pitch } : { x: roll, y: thr });
  const R = 34;
</script>

<div class="sticks" aria-label="Stick positions">
  {#each [left, right] as s}
    <svg viewBox="-42 -42 84 84" width="84" height="84">
      <rect x={-R} y={-R} width={R * 2} height={R * 2} rx="8" />
      <line x1={-R} y1="0" x2={R} y2="0" />
      <line x1="0" y1={-R} x2="0" y2={R} />
      <circle cx={Math.max(-1, Math.min(1, s.x)) * R} cy={-Math.max(-1, Math.min(1, s.y)) * R} r="6" />
    </svg>
  {/each}
  <div class="thr">{Math.round(((thr + 1) / 2) * 100)}%</div>
</div>

<style>
  .sticks {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    display: flex;
    gap: 18px;
    align-items: center;
    background: rgb(10 14 20 / 0.6);
    border-radius: 10px;
    padding: 6px 10px;
    pointer-events: none;
    z-index: 2;
  }
  rect {
    fill: rgb(255 255 255 / 0.06);
    stroke: rgb(255 255 255 / 0.5);
  }
  line {
    stroke: rgb(255 255 255 / 0.2);
  }
  circle {
    fill: #ffb547;
    stroke: #111;
  }
  .thr {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 2px;
    font-size: 0.7rem;
    color: #cfd7df;
  }
</style>
