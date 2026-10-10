<script lang="ts">
  import { app, prefs, savePrefs } from "../state.svelte";

  let token = $state(prefs.ionToken);

  function close() {
    prefs.ionToken = token.trim();
    savePrefs();
    app.showSettings = false;
  }
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="dialog" role="dialog" aria-label="Settings">
    <h2>Settings</h2>

    <section>
      <h3>Map</h3>
      <label>
        Source
        <select bind:value={prefs.mapMode}>
          <option value="google3d">Google Photorealistic 3D (needs Cesium ion token)</option>
          <option value="estonia">Open data: Estonian orthophoto + terrain</option>
        </select>
      </label>
      <label>
        Cesium ion token
        <input type="password" bind:value={token} placeholder="eyJhbGciOi…" autocomplete="off" />
      </label>
      <p class="hint">
        Free Community account at <a href="https://ion.cesium.com/signup" target="_blank" rel="noreferrer">ion.cesium.com</a>
        (personal, non-commercial use). Copy the default token from Access Tokens. It's stored only in this browser.
      </p>
    </section>

    <section>
      <h3>Cameras</h3>
      <label>FPV camera uptilt <span>{prefs.fpvUptilt}°</span><input type="range" min="0" max="60" bind:value={prefs.fpvUptilt} /></label>
      <label>FPV field of view <span>{prefs.fpvFov}°</span><input type="range" min="60" max="150" bind:value={prefs.fpvFov} /></label>
      <label>Chase distance <span>{prefs.chaseDistance} m</span><input type="range" min="2" max="40" bind:value={prefs.chaseDistance} /></label>
    </section>

    <section>
      <h3>Display</h3>
      <label>
        Stick mode
        <select bind:value={prefs.stickMode}>
          <option value={2}>Mode 2 (throttle left)</option>
          <option value={1}>Mode 1 (throttle right)</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" bind:checked={prefs.imperial} /> Imperial units</label>
    </section>

    <div class="actions"><button class="primary" onclick={close}>Done</button></div>
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
    padding: 16px 18px;
    width: min(480px, calc(100vw - 32px));
    max-height: 90vh;
    overflow: auto;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 1.1rem;
  }
  h3 {
    margin: 14px 0 6px;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  label {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    margin: 6px 0;
  }
  label select,
  label input[type="password"],
  label input[type="range"] {
    grid-column: 1 / -1;
    width: 100%;
  }
  label.check {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .hint {
    font-size: 0.8rem;
    color: var(--muted);
    margin: 4px 0 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
</style>
