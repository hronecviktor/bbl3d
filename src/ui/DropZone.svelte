<script lang="ts">
  import { loadSamples, type Sample } from "./samples";

  let {
    dragging,
    onfile,
    onsample,
  }: { dragging: boolean; onfile: (f: File) => void; onsample: (s: Sample) => void } = $props();
  const samples = loadSamples();
</script>

<div class="drop" class:dragging>
  <div class="card">
    <h1>Drop a Betaflight blackbox log</h1>
    <p>.bbl / .bfl files from the flight controller's flash or SD card. Files with several logs let you pick one.</p>
    <label class="btn">
      Choose file…
      <input type="file" accept=".bbl,.bfl,.txt,.BBL,.BFL" onchange={(e) => e.currentTarget.files?.[0] && onfile(e.currentTarget.files[0])} />
    </label>
    <p class="small">The log is parsed in your browser and never uploaded. Map tiles come from the selected map source.</p>
    {#await samples then list}
      {#if list.length}
        <h2>Or try a sample flight</h2>
        <div class="samples">
          {#each list as s}
            <button class="sample" onclick={() => onsample(s)}>
              <strong>{s.title}</strong>
              <span>{s.description}</span>
              <small>{Math.floor(s.duration / 60)}:{String(s.duration % 60).padStart(2, "0")} · synthetic log</small>
            </button>
          {/each}
        </div>
        <p class="small">Best viewed with Google 3D (free Cesium ion token in Settings).</p>
      {/if}
    {/await}
  </div>
</div>

<style>
  .drop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    z-index: 4;
  }
  .drop.dragging .card {
    border-color: var(--accent);
    border-style: dashed;
  }
  .card {
    background: var(--panel);
    border: 2px solid var(--line);
    border-radius: 12px;
    padding: 24px 28px;
    max-width: 520px;
    max-height: calc(100% - 32px);
    overflow: auto;
    margin: 16px;
    text-align: center;
  }
  h1 {
    font-size: 1.25rem;
    margin: 0 0 8px;
  }
  p {
    color: var(--muted);
  }
  h2 {
    font-size: 1rem;
    margin: 22px 0 10px;
  }
  .samples {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
  }
  .sample {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
  }
  .sample span {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .sample small {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .small {
    font-size: 0.8rem;
  }
  .btn {
    position: relative;
    display: inline-block;
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
    cursor: pointer;
  }
  .btn input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
</style>
