// Single trees from the Land Board's LOD0 vegetation layer (aerial laser
// scanning: position, type, height, crown diameter) → public/tiles/ee-trees.
// Each tile holds two instanced low-poly meshes (conifer, deciduous) using
// EXT_mesh_gpu_instancing, scaled per tree and set on the app's terrain.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { cellFrame, cellKey, download, groundAt, inDocker, ogr2ogr, vsizip, writeGlb, writeTileset } from "./common.mjs";

const TRUNK = [96, 72, 52, 255];
const CONIFER = [38, 78, 44, 255];
const DECIDUOUS = [84, 128, 56, 255];

// Unit trees: 1 m tall, 1 m crown diameter, base at the origin, glTF y-up.
function conifer() {
  return merge(cylinder(0.035, 0, 0.25, 6, TRUNK), cone(0.5, 0.12, 1, 8, CONIFER));
}

function deciduous() {
  return merge(cylinder(0.04, 0, 0.45, 6, TRUNK), ellipsoid([0.5, 0.33, 0.5], 0.64, 8, 5, DECIDUOUS));
}

export async function buildTrees(area, outDir) {
  const zip = download("vegetatsioon", area);
  const csv = zip.replace(/\.zip$/, "-trees.csv");
  ogr2ogr(zip, csv, [
    "-f", "CSV", "-t_srs", "EPSG:4326", "-lco", "GEOMETRY=AS_XY",
    "-select", "puutyyp,korgus,puukroon",
    inDocker(csv), vsizip(zip), "yksikpuud_keskpunkt",
  ]);

  const cells = new Map();
  let count = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    const cols = line.split(",");
    if (!head) {
      head = Object.fromEntries(cols.map((c, k) => [c.replace(/"/g, ""), k]));
      continue;
    }
    const lon = +cols[head.X];
    const lat = +cols[head.Y];
    const height = +cols[head.korgus];
    const crown = +cols[head.puukroon];
    if (!Number.isFinite(lon) || !(height > 0)) continue;
    const kind = cols[head.puutyyp].replace(/"/g, "") === "Okaspuu" ? "conifer" : "deciduous";
    const [i, j] = cellKey(lat, lon);
    const key = `${i},${j}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { i, j, frame: cellFrame(i, j), conifer: [], deciduous: [], b: [Infinity, Infinity, -Infinity, -Infinity], lo: Infinity, hi: -Infinity };
      cells.set(key, cell);
    }
    const ground = await groundAt(lat, lon);
    const [x, y, z] = cell.frame.toGltf(lon, lat, ground);
    cell[kind].push(x, y, z, Math.max(1, crown), height);
    cell.b = [Math.min(cell.b[0], lon), Math.min(cell.b[1], lat), Math.max(cell.b[2], lon), Math.max(cell.b[3], lat)];
    cell.lo = Math.min(cell.lo, ground);
    cell.hi = Math.max(cell.hi, ground + height);
    if (++count % 200000 === 0) console.log(`  ${count} trees…`);
  }

  const models = { conifer: conifer(), deciduous: deciduous() };
  const tiles = [];
  for (const c of cells.values()) {
    const attrs = [];
    const meshes = [];
    for (const kind of ["conifer", "deciduous"]) {
      const list = c[kind];
      if (!list.length) continue;
      const m = models[kind];
      const base = attrs.length;
      const n = list.length / 5;
      const tr = new Float32Array(n * 3);
      const sc = new Float32Array(n * 3);
      const rot = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) {
        const [x, y, z, crown, height] = list.slice(k * 5, k * 5 + 5);
        tr.set([x, y, z], k * 3);
        sc.set([crown, height, crown], k * 3);
        // random yaw so the low-poly shapes don't all line up
        const a = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % (2 * Math.PI);
        rot.set([0, Math.sin(a / 2), 0, Math.cos(a / 2)], k * 4);
      }
      attrs.push(
        { data: m.pos, type: "VEC3", target: 34962, minmax: true },
        { data: m.nrm, type: "VEC3", target: 34962 },
        { data: m.col, type: "VEC4", target: 34962, normalized: true },
        { data: tr, type: "VEC3" },
        { data: sc, type: "VEC3" },
        { data: rot, type: "VEC4" },
      );
      meshes.push({
        attributes: { POSITION: base, NORMAL: base + 1, COLOR_0: base + 2 },
        instancing: { TRANSLATION: base + 3, SCALE: base + 4, ROTATION: base + 5 },
      });
    }
    if (!meshes.length) continue;
    tiles.push({
      i: c.i,
      j: c.j,
      bounds: c.b,
      minH: c.lo,
      maxH: c.hi,
      glb: writeGlb({ attrs, meshes, extensions: ["EXT_mesh_gpu_instancing"] }),
    });
  }
  writeTileset(outDir, tiles, { name: `${area} trees`, loadRadius: 1500 });
  console.log(`trees: ${count} in ${tiles.length} tiles → ${path.relative(process.cwd(), outDir)}`);
}

// --- low-poly geometry (non-indexed, flat normals per face) ---

function mesh() {
  return { pos: [], nrm: [], col: [] };
}

function tri(m, a, b, c, color) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  for (const p of [a, b, c]) {
    m.pos.push(...p);
    m.nrm.push(n[0] / l, n[1] / l, n[2] / l);
    m.col.push(...color);
  }
}

const ring = (r, y, k, seg) => [Math.cos((k / seg) * 2 * Math.PI) * r, y, Math.sin((k / seg) * 2 * Math.PI) * r];

function cylinder(r, y0, y1, seg, color) {
  const m = mesh();
  for (let k = 0; k < seg; k++) {
    const a0 = ring(r, y0, k, seg);
    const a1 = ring(r, y0, k + 1, seg);
    const b0 = ring(r, y1, k, seg);
    const b1 = ring(r, y1, k + 1, seg);
    tri(m, a0, b1, a1, color);
    tri(m, a0, b0, b1, color);
  }
  return m;
}

function cone(r, y0, y1, seg, color) {
  const m = mesh();
  for (let k = 0; k < seg; k++) {
    const a0 = ring(r, y0, k, seg);
    const a1 = ring(r, y0, k + 1, seg);
    tri(m, a0, [0, y1, 0], a1, color);
    tri(m, a0, a1, [0, y0, 0], color);
  }
  return m;
}

function ellipsoid([rx, ry, rz], cy, seg, rings, color) {
  const m = mesh();
  const pt = (k, l) => {
    const th = (l / rings) * Math.PI;
    const ph = (k / seg) * 2 * Math.PI;
    return [Math.sin(th) * Math.cos(ph) * rx, cy + Math.cos(th) * ry, Math.sin(th) * Math.sin(ph) * rz];
  };
  for (let l = 0; l < rings; l++) {
    for (let k = 0; k < seg; k++) {
      const a = pt(k, l);
      const b = pt(k + 1, l);
      const c = pt(k, l + 1);
      const d = pt(k + 1, l + 1);
      if (l > 0) tri(m, a, b, d, color);
      if (l < rings - 1) tri(m, a, d, c, color);
    }
  }
  return m;
}

function merge(...parts) {
  return {
    pos: new Float32Array(parts.flatMap((p) => p.pos)),
    nrm: new Float32Array(parts.flatMap((p) => p.nrm)),
    col: new Uint8Array(parts.flatMap((p) => p.col)),
  };
}
