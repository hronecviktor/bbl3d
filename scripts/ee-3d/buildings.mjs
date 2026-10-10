// LOD2 buildings → public/tiles/ee-buildings (untextured: walls light, roofs
// red-brown). Each building is moved vertically so its base sits on the app's
// terrain, which differs from the Land Board's own heights by a metre or so.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import earcut from "earcut";
import { boundsOf, cellFrame, cellKey, download, groundAt, ogr2ogr, vsizip, inDocker, writeGlb, writeTileset } from "./common.mjs";

const WALL = [210, 204, 196, 255];
const ROOF = [140, 92, 76, 255];

export async function buildBuildings(area, outDir) {
  const zip = download("hooned_lod2", area);
  const geojsonl = zip.replace(/\.zip$/, ".geojsonl");
  const layerSource = zip.endsWith("gdb.zip") ? `${vsizip(zip)}/${path.basename(zip).replace(/-gdb\.zip$/, ".gdb")}` : vsizip(zip);
  ogr2ogr(zip, geojsonl, ["-f", "GeoJSONSeq", "-t_srs", "EPSG:4326", "-lco", "COORDINATE_PRECISION=8", inDocker(geojsonl), layerSource, "hooned_lod2"]);

  const cells = new Map();
  let count = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(geojsonl), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    const g = f.geometry;
    if (!g || g.type !== "MultiPolygon") continue;
    const [lon, lat] = g.coordinates[0][0][0];
    const [i, j] = cellKey(lat, lon);
    const key = `${i},${j}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { i, j, frame: cellFrame(i, j), pos: [], nrm: [], col: [], pts: [], minH: Infinity, maxH: -Infinity }));
    const zMin = f.properties?.z_min ?? Math.min(...g.coordinates.flat(2).map((p) => p[2]));
    const dz = (await groundAt(lat, lon)) - zMin;
    for (const poly of g.coordinates) addFace(cell, poly, dz);
    if (++count % 10000 === 0) console.log(`  ${count} buildings…`);
  }

  const tiles = [];
  for (const c of cells.values()) {
    if (!c.pos.length) continue;
    const pos = new Float32Array(c.pos);
    tiles.push({
      i: c.i,
      j: c.j,
      bounds: boundsOf(c.pts),
      minH: c.minH,
      maxH: c.maxH,
      glb: writeGlb({
        attrs: [
          { data: pos, type: "VEC3", target: 34962, minmax: true },
          { data: new Float32Array(c.nrm), type: "VEC3", target: 34962 },
          { data: new Uint8Array(c.col), type: "VEC4", target: 34962, normalized: true },
        ],
        meshes: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 } }],
      }),
    });
  }
  writeTileset(outDir, tiles, { name: `${area} LOD2 buildings`, loadRadius: 4000 });
  console.log(`buildings: ${count} in ${tiles.length} tiles → ${path.relative(process.cwd(), outDir)}`);
}

function addFace(cell, rings, dz) {
  const local = rings.map((r) => dedupe(r.map(([lon, lat, h]) => cell.frame.toGltf(lon, lat, h + dz))));
  if (local[0].length < 3) return;
  const n = newell(local[0]);
  const len = Math.hypot(...n);
  if (len < 1e-9) return;
  const nn = n.map((v) => v / len);
  // triangulate in the plane's two dominant axes
  const drop = nn.map(Math.abs).indexOf(Math.max(...nn.map(Math.abs)));
  const axes = [0, 1, 2].filter((a) => a !== drop);
  const flat = [];
  const verts = [];
  const holes = [];
  for (const r of local) {
    if (verts.length) holes.push(verts.length);
    for (const p of r) {
      flat.push(p[axes[0]], p[axes[1]]);
      verts.push(p);
    }
  }
  // glTF y is up: a face is a roof when its normal points mostly up or down
  const color = Math.abs(nn[1]) > 0.3 ? ROOF : WALL;
  for (const idx of earcut(flat, holes)) {
    const p = verts[idx];
    cell.pos.push(...p);
    cell.nrm.push(...nn);
    cell.col.push(...color);
    cell.minH = Math.min(cell.minH, p[1]);
    cell.maxH = Math.max(cell.maxH, p[1]);
  }
  for (const r of rings) for (const p of r) cell.pts.push(p);
}

function dedupe(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-3) out.push(p);
  }
  while (out.length > 1 && Math.hypot(...out[0].map((v, k) => v - out[out.length - 1][k])) <= 1e-3) out.pop();
  return out;
}

// Newell's method: polygon normal, robust for slightly non-planar rings
function newell(ring) {
  const n = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1, z1] = ring[i];
    const [x2, y2, z2] = ring[(i + 1) % ring.length];
    n[0] += (y1 - y2) * (z1 + z2);
    n[1] += (z1 - z2) * (x1 + x2);
    n[2] += (x1 - x2) * (y1 + y2);
  }
  return n;
}
