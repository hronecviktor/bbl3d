<script lang="ts">
  import { app, current } from "../state.svelte";
  import { fmtDistance, fmtDuration, fmtSpeed } from "./format";

  let { onpick }: { onpick: (index: number) => void } = $props();

  function startTime(s: string) {
    // "2026-09-07T13:33:51.226+00:00"; FCs without a clock log year 0000
    if (!s || s.startsWith("0000")) return "no clock";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
  }
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && current.flight && (app.pickingLog = false)}>
  <div class="dialog" role="dialog" aria-label="Pick a log">
    <h2>{app.fileName}: {app.logs.length} logs</h2>
    <div class="list">
      {#each app.logs as l}
        <button class="log" disabled={!!l.error} onclick={() => onpick(l.index)}>
          <div class="row1">
            <strong>Log {l.index + 1}</strong>
            <span>{fmtDuration(l.durationS)}</span>
            {#if l.cutOff}<span class="badge warn" title="No clean log end: power loss, crash or full flash">cut off</span>{/if}
            {#if !l.hasGps}<span class="badge">no GPS</span>{/if}
          </div>
          {#if l.error}
            <div class="muted">Unreadable: {l.error}</div>
          {:else}
            <div class="muted">
              {startTime(l.logStart)} · {l.craftName || "unnamed craft"}
              {#if l.maxSpeed}· max {fmtSpeed(l.maxSpeed)}{/if}
              {#if l.maxDistance}· {fmtDistance(l.maxDistance)} out{/if}
            </div>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.5);
    display: grid;
    place-items: center;
    z-index: 20;
  }
  .dialog {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 16px;
    width: min(560px, calc(100vw - 32px));
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  h2 {
    font-size: 1rem;
    margin: 0 0 12px;
  }
  .list {
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .log {
    text-align: left;
    padding: 8px 10px;
  }
  .row1 {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin-top: 2px;
  }
  .badge {
    font-size: 0.75rem;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--line);
  }
  .badge.warn {
    border-color: var(--warn);
    color: var(--warn);
  }
</style>
