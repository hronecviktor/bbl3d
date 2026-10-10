import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumSource = "node_modules/cesium/Build/Cesium";
// Cesium loads its workers, assets and widget CSS at runtime from this path.
const cesiumBaseUrl = "cesium";

export default defineConfig({
  base: "./",
  define: {
    CESIUM_BASE_URL: JSON.stringify(cesiumBaseUrl),
  },
  plugins: [
    svelte(),
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
      ],
    }),
  ],
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
