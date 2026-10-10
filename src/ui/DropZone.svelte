<script lang="ts">
  let { dragging, onfile }: { dragging: boolean; onfile: (f: File) => void } = $props();
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
    max-width: 440px;
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
