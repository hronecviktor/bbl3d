// The two map modes. Both are free; neither needs a credit card.
//  - google3d: Google Photorealistic 3D Tiles through a Cesium ion Community
//    token (ion asset 2275207, no Google key needed).
//  - estonia: Land Board orthophoto (Estonia only, Esri World Imagery around
//    it) on keyless terrain, plus locally converted Land Board LOD2 buildings
//    if `npm run tiles:ee` has been run.
import {
  Cesium3DTileset,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Ion,
  Rectangle,
  UrlTemplateImageryProvider,
  createGooglePhotorealistic3DTileset,
  type Viewer,
} from "cesium";
import { terrariumTerrain } from "./terrain";

export type MapMode = "google3d" | "estonia";

const ESTONIA = Rectangle.fromDegrees(21.5, 57.4, 28.3, 59.9);
// built locally by `npm run tiles:ee` (scripts/ee-3d)
const LOCAL_TILESETS = ["tiles/ee-buildings/tileset.json", "tiles/ee-trees/tileset.json"];

// The dev/preview servers answer unknown paths with index.html, so check the type too.
async function exists(url: string) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok && (res.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

export interface ActiveLayers {
  mode: MapMode;
  tileset: Cesium3DTileset | null; // what the ground height is sampled from, if not terrain
  primitives: Cesium3DTileset[]; // added to the scene by this mode; removed on switch
  note: string | null; // shown to the user (fallbacks, missing data)
}

export function removeLayers(viewer: Viewer, layers: ActiveLayers | null) {
  for (const p of layers?.primitives ?? []) viewer.scene.primitives.remove(p);
}

export async function applyMapMode(viewer: Viewer, mode: MapMode, ionToken: string): Promise<ActiveLayers> {
  const scene = viewer.scene;
  viewer.imageryLayers.removeAll();

  if (mode === "google3d") {
    if (!ionToken) {
      const res = await applyMapMode(viewer, "estonia", "");
      return { ...res, note: "Google 3D needs a Cesium ion token (Settings). Showing open data instead." };
    }
    Ion.defaultAccessToken = ionToken;
    try {
      const tileset = await createGooglePhotorealistic3DTileset(
        { onlyUsingWithGoogleGeocoder: true },
        { maximumScreenSpaceError: 8 },
      );
      scene.globe.show = false;
      viewer.terrainProvider = new EllipsoidTerrainProvider();
      scene.primitives.add(tileset);
      return { mode, tileset, primitives: [tileset], note: null };
    } catch (e) {
      const res = await applyMapMode(viewer, "estonia", "");
      return { ...res, note: `Google 3D failed to load (${e instanceof Error ? e.message : e}). Showing open data instead.` };
    }
  }

  scene.globe.show = true;
  viewer.terrainProvider = terrariumTerrain();
  viewer.imageryLayers.add(
    new ImageryLayer(
      new UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maximumLevel: 19,
        credit: new Credit("Imagery: Esri, Maxar, Earthstar Geographics"),
      }),
    ),
  );
  viewer.imageryLayers.add(
    new ImageryLayer(
      new UrlTemplateImageryProvider({
        url: "https://tiles.maaamet.ee/tm/tms/1.0.0/foto@GMC/{z}/{x}/{reverseY}.jpg",
        // the service has no tiles below zoom 6 and none above 18
        minimumLevel: 6,
        maximumLevel: 18,
        rectangle: ESTONIA,
        credit: new Credit("Orthophoto: Maa- ja Ruumiamet"),
      }),
    ),
  );
  const primitives: Cesium3DTileset[] = [];
  let note: string | null = null;
  for (const url of LOCAL_TILESETS) {
    if (!(await exists(url))) continue;
    try {
      const tileset = await Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 16 });
      scene.primitives.add(tileset);
      primitives.push(tileset);
    } catch (e) {
      note = `${url} failed to load: ${e instanceof Error ? e.message : e}`;
    }
  }
  // buildings and trees are for looks; heights still come from the terrain
  return { mode, tileset: null, primitives, note };
}
