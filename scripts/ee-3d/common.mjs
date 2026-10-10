// Shared helpers for the Estonian 3D data build: geoportal downloads, GDAL in
// Docker, terrain heights from the same terrarium tiles the app renders, and
// glTF / 3D Tiles writing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Cartesian3, Matrix4, Transforms } from "cesium";

export const WORK = path.resolve("scripts/ee-3d/work");
export const GDAL_IMAGE = "ghcr.io/osgeo/gdal:alpine-small-3.11.4";
export const CELL_LAT = 0.004; // ≈ 445 m
export const CELL_LON = 0.008; // ≈ 450 m at 59.4°N
const GROUP = 8; // leaf cells per parent cell edge
const R = 6378137;
const GEOPORTAL = "https://geoportaal.maaamet.ee";
const DOWNLOAD_PAGE = `${GEOPORTAL}/eng/Download-3D-data-p837.html`;

fs.mkdirSync(WORK, { recursive: true });

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  return out;
}

/** File names on the download page for a dataset type and area, e.g. ("vegetatsioon", "Tallinn"). */
function listedFiles(type, area) {
  const page = path.join(WORK, "download-page.html");
  if (!fs.existsSync(page)) execFileSync("curl", ["-sSfL", "-o", page, DOWNLOAD_PAGE]);
  const html = fs.readFileSync(page, "utf8");
  const re = new RegExp(`f=(${type}-${area}(?:-\\d+)?-(?:gdb|gpkg)\\.zip)`, "g");
  return [...new Set([...html.matchAll(re)].map((m) => decodeURIComponent(m[1])))];
}

/** Download a dataset zip for an area (prefers GeoPackage, then FileGDB). */
export function download(type, area) {
  const files = listedFiles(type, area).sort((a) => (a.endsWith("gpkg.zip") ? -1 : 1));
  if (!files.length) throw new Error(`no ${type} download for "${area}" on ${DOWNLOAD_PAGE}`);
  for (const name of files) {
    const file = path.join(WORK, name);
    if (fs.existsSync(file)) return file;
    const url = `${GEOPORTAL}/index.php?lang_id=2&plugin_act=otsing&andmetyyp=${type}&dl=1&f=${encodeURIComponent(name)}&page_id=837`;
    console.log(`downloading ${name}`);
    execFileSync("curl", ["-sSfL", "-o", file, url], { stdio: "inherit" });
    // the portal answers missing files with an HTML page
    if (fs.readFileSync(file).subarray(0, 2).toString() === "PK") return file;
    fs.rmSync(file);
    console.log(`  ${name} is listed but not available, trying the next format`);
  }
  throw new Error(`none of ${files.join(", ")} could be downloaded`);
}

/** Run ogr2ogr in Docker on a zip in WORK; returns the output path. */
export function ogr2ogr(zip, out, args) {
  if (fs.existsSync(out)) return out;
  console.log(`converting ${path.basename(zip)} with GDAL (${GDAL_IMAGE})`);
  execFileSync(
    "docker",
    ["run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-v", `${WORK}:/data`, GDAL_IMAGE, "ogr2ogr", ...args],
    { stdio: "inherit" },
  );
  return out;
}

export const inDocker = (file) => `/data/${path.relative(WORK, file)}`;
export const vsizip = (zip) => `/vsizip/${inDocker(zip)}`;

// --- terrain: AWS terrarium tiles at zoom 15, as in src/map/terrain.ts ---

const TERRAIN_ZOOM = 15;
const tiles = new Map();

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("expected 8-bit RGB non-interlaced PNG");
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const h = new Float32Array(width * height);
  for (let i = 0; i < h.length; i++) h[i] = px[i * 3] * 256 + px[i * 3 + 1] + px[i * 3 + 2] / 256 - 32768;
  return h;
}

async function terrainTile(x, y) {
  const key = `${x}/${y}`;
  if (tiles.has(key)) return tiles.get(key);
  const dir = path.join(WORK, "terrarium", String(TERRAIN_ZOOM), String(x));
  const file = path.join(dir, `${y}.png`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${x}/${y}.png`);
    if (!res.ok) throw new Error(`terrain tile ${key}: HTTP ${res.status}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const h = decodePng(fs.readFileSync(file));
  tiles.set(key, h);
  return h;
}

/** Ground height (m) as rendered by the app's terrain. */
export async function groundAt(lat, lon) {
  const n = 1 << TERRAIN_ZOOM;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const h = await terrainTile(x, y);
  const px = Math.min(255, (fx - x) * 256);
  const py = Math.min(255, (fy - y) * 256);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(255, x0 + 1);
  const y1 = Math.min(255, y0 + 1);
  const ax = px - x0;
  const ay = py - y0;
  const top = h[y0 * 256 + x0] * (1 - ax) + h[y0 * 256 + x1] * ax;
  const bot = h[y1 * 256 + x0] * (1 - ax) + h[y1 * 256 + x1] * ax;
  return top * (1 - ay) + bot * ay;
}

// --- grid cells ---

export function cellKey(lat, lon) {
  return [Math.floor(lat / CELL_LAT), Math.floor(lon / CELL_LON)];
}

/** Local frame of a cell: metres east/north around its centre. */
export function cellFrame(i, j) {
  const lat0 = (i + 0.5) * CELL_LAT;
  const lon0 = (j + 0.5) * CELL_LON;
  const k = Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0,
    lon0,
    // glTF is y-up: (east, up, -north)
    toGltf: (lon, lat, h) => [((lon - lon0) * Math.PI * R * k) / 180, h, -((lat - lat0) * Math.PI * R) / 180],
  };
}

// --- glTF writing ---

/**
 * Build a GLB from accessors. `attrs` entries: { data: TypedArray, type:
 * "SCALAR"|"VEC3"|"VEC4", target?, normalized?, minmax? }. `meshes`:
 * [{ attributes: {NAME: idx}, indices?, instancing?: {NAME: idx} }].
 */
export function writeGlb({ attrs, meshes, extensions = [] }) {
  const views = [];
  const accessors = [];
  const chunks = [];
  let off = 0;
  const componentType = (a) =>
    a instanceof Float32Array ? 5126 : a instanceof Uint8Array ? 5121 : a instanceof Int8Array ? 5120 : a instanceof Uint16Array ? 5123 : 5125;
  const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 };
  for (const a of attrs) {
    // keep every element 4-byte aligned: use float, or 4-component byte, formats only
    const b = Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(a.target ? { target: a.target } : {}) });
    const pad = (4 - (b.length % 4)) % 4;
    chunks.push(b, Buffer.alloc(pad));
    off += b.length + pad;
    const acc = { bufferView: views.length - 1, componentType: componentType(a.data), count: a.data.length / comps[a.type], type: a.type };
    if (a.normalized) acc.normalized = true;
    if (a.minmax) {
      const n = comps[a.type];
      acc.min = Array(n).fill(Infinity);
      acc.max = Array(n).fill(-Infinity);
      for (let i = 0; i < a.data.length; i++) {
        acc.min[i % n] = Math.min(acc.min[i % n], a.data[i]);
        acc.max[i % n] = Math.max(acc.max[i % n], a.data[i]);
      }
    }
    accessors.push(acc);
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "bbl3d ee-3d" },
    ...(extensions.length ? { extensionsUsed: extensions, extensionsRequired: extensions } : {}),
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((m, i) => ({
      mesh: i,
      ...(m.instancing ? { extensions: { EXT_mesh_gpu_instancing: { attributes: m.instancing } } } : {}),
    })),
    meshes: meshes.map((m) => ({ primitives: [{ attributes: m.attributes, ...(m.indices !== undefined ? { indices: m.indices } : {}), material: 0 }] })),
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  return Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}

// --- tileset writing ---

/**
 * Write tiles and tileset.json. `tiles`: [{ i, j, glb: Buffer, bounds:
 * [w,s,e,n] degrees, minH, maxH }]. Leaves under each parent load within
 * roughly `loadRadius` metres of the camera.
 */
export function writeTileset(outDir, tiles, { name, loadRadius }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const rad = (d) => (d * Math.PI) / 180;
  const region = (b, lo, hi) => [rad(b[0]), rad(b[1]), rad(b[2]), rad(b[3]), lo, hi];
  const groups = new Map();
  for (const t of tiles) {
    const file = `${t.i}_${t.j}.glb`;
    fs.writeFileSync(path.join(outDir, file), t.glb);
    const { lat0, lon0 } = cellFrame(t.i, t.j);
    const leaf = {
      boundingVolume: { region: region(t.bounds, t.minH, t.maxH) },
      geometricError: 0,
      transform: Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon0, lat0, 0))),
      content: { uri: file },
    };
    const key = `${Math.floor(t.i / GROUP)},${Math.floor(t.j / GROUP)}`;
    const g = groups.get(key) ?? { children: [], b: [Infinity, Infinity, -Infinity, -Infinity], lo: Infinity, hi: -Infinity };
    g.children.push(leaf);
    g.b = [Math.min(g.b[0], t.bounds[0]), Math.min(g.b[1], t.bounds[1]), Math.max(g.b[2], t.bounds[2]), Math.max(g.b[3], t.bounds[3])];
    g.lo = Math.min(g.lo, t.minH);
    g.hi = Math.max(g.hi, t.maxH);
    groups.set(key, g);
  }
  // Cesium refines a tile when geometricError / distance * (screen height /
  // (2 tan(fov/2))) exceeds 16 px; ≈ 0.03 × radius for a 900 px tall view.
  const parentError = loadRadius * 0.03;
  const children = [...groups.values()].map((g) => ({
    boundingVolume: { region: region(g.b, g.lo, g.hi) },
    geometricError: parentError,
    children: g.children,
  }));
  const all = children
    .map((c) => c.boundingVolume.region)
    .reduce((a, r) => [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3]), Math.min(a[4], r[4]), Math.max(a[5], r[5])]);
  const tileset = {
    asset: { version: "1.1", tilesetVersion: name, generator: "bbl3d ee-3d" },
    geometricError: 2000,
    root: { boundingVolume: { region: all }, geometricError: 1000, refine: "ADD", children },
  };
  fs.writeFileSync(path.join(outDir, "tileset.json"), JSON.stringify(tileset));
}

export function boundsOf(points) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) {
    b[0] = Math.min(b[0], lon);
    b[1] = Math.min(b[1], lat);
    b[2] = Math.max(b[2], lon);
    b[3] = Math.max(b[3], lat);
  }
  return b;
}
