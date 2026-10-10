<script lang="ts">
  import { FAILSAFE_PHASE } from "../flight/flight";
  import { FLIGHT_MODES, MODE_LABEL } from "../flight/modes";
  import { app, current } from "../state.svelte";
  import { fmtAlt, fmtDistance, fmtDuration, fmtSpeed } from "./format";

  const f = $derived(current.flight!);
  // GPS fields are NaN until the first fix
  const num = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? undefined : v);
  const t = $derived(app.t);
  const i = $derived(f.indexAt(t));
  const pose = $derived(f.poseAt(t));
  const home = $derived(pose ? f.homeVector(pose) : null);
  const modes = $derived(f.activeModes(t));
  const armed = $derived(modes.includes("ARM"));
  const flightModes = $derived(modes.filter((m) => FLIGHT_MODES.has(m) && m !== "AIRMODE"));
  const v = $derived(num(f.series("vbatLatest")?.[i]));
  const a = $derived(num(f.series("amperageLatest")?.[i]));
  const mah = $derived(f.mAh?.[i]);
  const fs = $derived(num(f.raw("failsafePhase")?.[i]) ?? 0);
  const rssi = $derived(num(f.series("rssi")?.[i]));
  const sats = $derived(num(f.raw("GPS_numSat")?.[i]));
  const speed = $derived(num(f.series("GPS_speed")?.[i]));
  // arrow pointing home, relative to the nose
  const homeArrow = $derived(home && pose ? ((home.bearing - pose.yaw) * 180) / Math.PI : 0);
</script>

<div class="hud">
  <div class="row big">
    <span class:armed class="state">{armed ? "ARMED" : "DISARMED"}</span>
    <span>{fmtDuration(t)}</span>
  </div>
  {#if flightModes.length || fs}
    <div class="row">
      {#each flightModes as m}<span class="mode" class:rescue={m === "GPSRESCUE"}>{MODE_LABEL[m] ?? m}</span>{/each}
      {#if fs}<span class="mode bad">Failsafe: {FAILSAFE_PHASE[fs] ?? fs}</span>{/if}
    </div>
  {/if}
  <dl>
    {#if speed !== undefined}<dt>Speed</dt><dd>{fmtSpeed(speed)}</dd>{/if}
    {#if pose}<dt>Alt</dt><dd>{fmtAlt(pose.relAlt)}</dd>{/if}
    {#if home}
      <dt>Home</dt>
      <dd>
        {fmtDistance(home.distance)}
        <span class="arrow" style="transform: rotate({homeArrow}deg)">↑</span>
      </dd>
    {/if}
    {#if v !== undefined}
      <dt>Battery</dt>
      <dd>{v.toFixed(1)} V{#if f.cells} · {(v / f.cells).toFixed(2)} V/cell{/if}</dd>
    {/if}
    {#if a !== undefined}<dt>Current</dt><dd>{a.toFixed(1)} A{#if mah !== undefined} · {mah.toFixed(0)} mAh{/if}</dd>{/if}
    {#if sats !== undefined}<dt>Sats</dt><dd>{sats}</dd>{/if}
    {#if rssi !== undefined}<dt>RSSI</dt><dd>{rssi.toFixed(0)} %</dd>{/if}
  </dl>
</div>

<style>
  .hud {
    position: absolute;
    left: 10px;
    top: 10px;
    background: rgb(10 14 20 / 0.72);
    color: #eef3f8;
    border-radius: 8px;
    padding: 8px 12px;
    font-variant-numeric: tabular-nums;
    font-size: 0.9rem;
    min-width: 190px;
    pointer-events: none;
    z-index: 2;
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .big {
    justify-content: space-between;
    font-weight: 700;
  }
  .state {
    color: #9aa6b2;
  }
  .state.armed {
    color: #ff6b5b;
  }
  .mode {
    font-size: 0.75rem;
    padding: 1px 6px;
    border-radius: 4px;
    background: #2a3a52;
  }
  .mode.rescue {
    background: #b35c00;
  }
  .mode.bad {
    background: #a3262a;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0;
  }
  dt {
    color: #9aa6b2;
  }
  dd {
    margin: 0;
    text-align: right;
  }
  .arrow {
    display: inline-block;
    color: #5bd18a;
    font-weight: 700;
  }
</style>
