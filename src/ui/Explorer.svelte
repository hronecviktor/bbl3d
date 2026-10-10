<script lang="ts">
  // Betaflight's Blackbox Explorer (GPL-3.0, built into public/blackbox-viewer
  // by `npm run viewer`) in an iframe, fed the open log and kept in sync with
  // the replay clock through the bridge in scripts/blackbox-viewer/bbl3d-embed.patch.
  import { onMount } from "svelte";
  import { app, current, openedFile } from "../state.svelte";

  let { visible }: { visible: boolean } = $props();

  let frame: HTMLIFrameElement;
  let ready = $state(false); // viewer page loaded
  let loadedFor: object | null = null; // flight the viewer has open
  let synced = $state(false); // the viewer has the log and our position
  let lastSentUs = -1;
  let resizing = $state(false);

  const post = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    frame?.contentWindow?.postMessage({ bbl3d: 1, ...msg }, location.origin, transfer);

  function open() {
    const f = current.flight;
    if (!ready || !f || !openedFile.bytes || loadedFor === f) return;
    loadedFor = f;
    synced = false;
    const bytes = openedFile.bytes.slice(0);
    post({ type: "open", name: openedFile.name, bytes, index: f.summary.index }, [bytes]);
  }

  function seek() {
    const f = current.flight;
    if (!f || !synced) return;
    const us = Math.round(f.startUs + app.t * 1e6);
    if (Math.abs(us - lastSentUs) < 1) return;
    lastSentUs = us;
    post({ type: "seek", time: us });
  }

  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame?.contentWindow || e.origin !== location.origin || e.data?.bbl3d !== 1) return;
      const f = current.flight;
      if (e.data.type === "loaded") {
        synced = true;
        lastSentUs = -1;
        seek(); // the viewer starts at the log start; move it to the replay
      } else if (e.data.type === "time" && f && synced) {
        // ignore echoes of our own seeks (the viewer snaps to its frames) and
        // the viewer's position while the replay is driving
        if (lastSentUs < 0 || app.playing || Math.abs(e.data.time - lastSentUs) < 20_000) return;
        const t = (e.data.time - f.startUs) / 1e6;
        if (t >= 0 && t <= f.duration) {
          lastSentUs = e.data.time;
          app.t = t;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // a new flight (or log in the same file) goes to the viewer
  $effect(() => {
    void current.flight;
    if (ready) open();
  });

  // replay clock → viewer
  $effect(() => {
    void app.t;
    if (visible) seek();
  });

  // the viewer lays itself out on resize; tell it when it becomes visible
  $effect(() => {
    if (visible && ready) {
      post({ type: "resize" });
      seek();
    }
  });

  function startResize(e: PointerEvent) {
    const y0 = e.clientY;
    const h0 = app.panelHeight;
    resizing = true;
    const move = (ev: PointerEvent) =>
      (app.panelHeight = Math.min(window.innerHeight * 0.85, Math.max(160, h0 - (ev.clientY - y0))));
    const up = () => {
      resizing = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      post({ type: "resize" });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<section class="explorer" class:hidden={!visible} style="height: {app.panelHeight}px" data-synced={synced}>
  <div class="grip" role="separator" aria-label="Resize explorer" onpointerdown={startResize}></div>
  <iframe
    bind:this={frame}
    src="blackbox-viewer/index.html"
    title="Betaflight Blackbox Explorer"
    class:resizing
    onload={() => {
      ready = true;
      open();
    }}
  ></iframe>
  <div class="credit">
    <a href="https://github.com/betaflight/blackbox-log-viewer" target="_blank" rel="noreferrer">Betaflight Blackbox Explorer</a>
    · GPL-3.0 · <a href="blackbox-viewer/SOURCE.md" target="_blank">source</a>
  </div>
</section>

<style>
  .explorer {
    position: relative;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--line);
    background: var(--panel);
    min-height: 160px;
  }
  .explorer.hidden {
    display: none;
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
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
  }
  iframe.resizing {
    pointer-events: none;
  }
  .credit {
    position: absolute;
    right: 8px;
    bottom: 4px;
    font-size: 10px;
    color: var(--muted);
    background: color-mix(in srgb, var(--panel) 80%, transparent);
    padding: 0 4px;
    border-radius: 3px;
  }
</style>
