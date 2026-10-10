// Keyless terrain from AWS Terrain Tiles (terrarium PNGs, Web Mercator, max
// zoom 15), meshed by Cesium's CustomHeightmapTerrainProvider. Deeper levels
// resample their level-15 ancestor.
import { Credit, CustomHeightmapTerrainProvider, WebMercatorTilingScheme } from "cesium";

const URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const MAX_ZOOM = 15;
const SIZE = 65; // heightmap samples per tile edge

const cache = new Map<string, Promise<Float32Array | null>>();

async function fetchTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${URL}/${key}.png`);
      if (!res.ok) return null;
      const img = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const h = new Float32Array(img.width * img.height);
      for (let i = 0; i < h.length; i++) {
        h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      }
      return h;
    })().catch(() => null);
    cache.set(key, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Terrain height (m) at a point, from the same tiles the globe is meshed from. */
export async function terrainHeightAt(lat: number, lon: number): Promise<number | null> {
  const n = 1 << MAX_ZOOM;
  const fx = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const fy = ((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const tile = await fetchTile(MAX_ZOOM, x, y);
  if (!tile) return null;
  return bilinear(tile, Math.min(255, (fx - x) * 256), Math.min(255, (fy - y) * 256));
}

/**
 * Load the terrain tiles covering a lat/lon box (plus a margin) and return a
 * synchronous sampler over them; it returns null outside the loaded tiles.
 */
export async function terrainSampler(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<((lat: number, lon: number) => number | null) | null> {
  const n = 1 << MAX_ZOOM;
  const tx = (lon: number) => ((lon + 180) / 360) * n;
  const ty = (lat: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const pad = 0.002;
  const x0 = Math.floor(tx(west - pad));
  const x1 = Math.floor(tx(east + pad));
  const y0 = Math.floor(ty(north + pad));
  const y1 = Math.floor(ty(south - pad));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return null; // a flight shouldn't span this much
  const tiles = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(fetchTile(MAX_ZOOM, x, y).then((h) => void (h && tiles.set(`${x}/${y}`, h))));
    }
  }
  await Promise.all(jobs);
  return (lat, lon) => {
    const fx = tx(lon);
    const fy = ty(lat);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const h = tiles.get(`${x}/${y}`);
    return h ? bilinear(h, Math.min(255, (fx - x) * 256), Math.min(255, (fy - y) * 256)) : null;
  };
}

export function terrariumTerrain() {
  return new CustomHeightmapTerrainProvider({
    width: SIZE,
    height: SIZE,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: new Credit("Terrain: Mapzen/Tilezen terrarium on AWS Open Data"),
    callback: async (x: number, y: number, level: number) => {
      const z = Math.min(level, MAX_ZOOM);
      const shift = level - z;
      const tx = x >> shift;
      const ty = y >> shift;
      const src = await fetchTile(z, tx, ty);
      const out = new Float32Array(SIZE * SIZE);
      if (!src) return out;
      // sub-window of the source tile covered by this tile, in source pixels
      const span = 256 / (1 << shift);
      const ox = (x - (tx << shift)) * span;
      const oy = (y - (ty << shift)) * span;
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const sx = Math.min(255, ox + (c / (SIZE - 1)) * span);
          const sy = Math.min(255, oy + (r / (SIZE - 1)) * span);
          out[r * SIZE + c] = bilinear(src, sx, sy);
        }
      }
      return out;
    },
  });
}

function bilinear(h: Float32Array, x: number, y: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(255, x0 + 1);
  const y1 = Math.min(255, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = h[y0 * 256 + x0] * (1 - fx) + h[y0 * 256 + x1] * fx;
  const b = h[y1 * 256 + x0] * (1 - fx) + h[y1 * 256 + x1] * fx;
  return a * (1 - fy) + b * fy;
}
