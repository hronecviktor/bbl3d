// Writes public/models/quad.glb: a simple 5" X-frame quad built from boxes and
// discs. glTF axes: +Z forward (nose), +Y up, +X left; Cesium's default model
// axes turn that into +X forward, +Z up.
import fs from "node:fs";

const meshes = []; // { name, color, positions[], normals[], indices[] }

function box(name, color, [cx, cy, cz], [sx, sy, sz], yawDeg = 0) {
  const c = Math.cos((yawDeg * Math.PI) / 180);
  const s = Math.sin((yawDeg * Math.PI) / 180);
  const rot = ([x, y, z]) => [x * c + z * s, y, -x * s + z * c];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const m = { name, color, positions: [], normals: [], indices: [] };
  for (const [n, u, v] of faces) {
    const base = m.positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + u[k] * a + v[k] * b) * [sx, sy, sz][k] / 2);
      const [x, y, z] = rot(p);
      m.positions.push(x + cx, y + cy, z + cz);
      m.normals.push(...rot(n));
    }
    // winding so the face normal points outward
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const out = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0;
    m.indices.push(...(out ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((i) => i + base));
  }
  meshes.push(m);
}

function disc(name, color, [cx, cy, cz], radius, segments = 32) {
  const m = { name, color, positions: [], normals: [], indices: [] };
  for (const side of [1, -1]) {
    const base = m.positions.length / 3;
    m.positions.push(cx, cy, cz);
    m.normals.push(0, side, 0);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * 2 * Math.PI;
      m.positions.push(cx + radius * Math.cos(a), cy, cz + radius * Math.sin(a));
      m.normals.push(0, side, 0);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + 1 + i;
      const b = base + 1 + ((i + 1) % segments);
      m.indices.push(...(side > 0 ? [base, b, a] : [base, a, b]));
    }
  }
  meshes.push(m);
}

// Dimensions in metres for a 5" freestyle quad (~225 mm motor to motor).
const ARM = 0.16 / Math.SQRT2 + 0.02;
const CARBON = [0.08, 0.08, 0.09, 1];
box("body", [0.2, 0.2, 0.22, 1], [0, 0.025, 0], [0.045, 0.035, 0.12]);
box("arm_fl", CARBON, [ARM / 2, 0, ARM / 2], [0.02, 0.006, 0.17], 45);
box("arm_fr", CARBON, [-ARM / 2, 0, ARM / 2], [0.02, 0.006, 0.17], -45);
box("arm_rl", CARBON, [ARM / 2, 0, -ARM / 2], [0.02, 0.006, 0.17], -45);
box("arm_rr", CARBON, [-ARM / 2, 0, -ARM / 2], [0.02, 0.006, 0.17], 45);
box("camera", [0.9, 0.15, 0.1, 1], [0, 0.03, 0.065], [0.022, 0.022, 0.02]);
box("battery", [0.85, 0.65, 0.1, 1], [0, 0.055, -0.005], [0.035, 0.03, 0.075]);
const motors = [[ARM, ARM], [-ARM, ARM], [ARM, -ARM], [-ARM, -ARM]];
const PROP_FRONT = [0.95, 0.25, 0.2, 0.55];
const PROP_REAR = [0.75, 0.8, 0.85, 0.45];
motors.forEach(([x, z], i) => {
  box(`motor${i}`, [0.55, 0.55, 0.6, 1], [x, 0.012, z], [0.025, 0.02, 0.025]);
  disc(`prop${i}`, z > 0 ? PROP_FRONT : PROP_REAR, [x, 0.026, z], 0.0635);
});

// --- glTF binary writer ---
const bufs = [];
let offset = 0;
const bufferViews = [];
const accessors = [];
function addView(typed, target) {
  const bytes = Buffer.from(typed.buffer);
  const pad = (4 - (bytes.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  bufs.push(bytes, Buffer.alloc(pad));
  offset += bytes.length + pad;
  return bufferViews.length - 1;
}
const materials = [];
const gltfMeshes = [];
for (const m of meshes) {
  const pos = new Float32Array(m.positions);
  const min = [0, 1, 2].map((k) => Math.min(...m.positions.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...m.positions.filter((_, i) => i % 3 === k)));
  accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
  const posAcc = accessors.length - 1;
  accessors.push({ bufferView: addView(new Float32Array(m.normals), 34962), componentType: 5126, count: pos.length / 3, type: "VEC3" });
  const nAcc = accessors.length - 1;
  accessors.push({ bufferView: addView(new Uint16Array(m.indices), 34963), componentType: 5123, count: m.indices.length, type: "SCALAR" });
  const iAcc = accessors.length - 1;
  materials.push({
    pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0.1, roughnessFactor: 0.6 },
    alphaMode: m.color[3] < 1 ? "BLEND" : "OPAQUE",
    doubleSided: true,
  });
  gltfMeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: posAcc, NORMAL: nAcc }, indices: iAcc, material: materials.length - 1 }] });
}
const bin = Buffer.concat(bufs);
const gltf = {
  asset: { version: "2.0", generator: "bbl3d make-quad-glb" },
  scene: 0,
  scenes: [{ nodes: gltfMeshes.map((_, i) => i) }],
  nodes: gltfMeshes.map((_, i) => ({ mesh: i })),
  meshes: gltfMeshes,
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const chunk = (type, data) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};
fs.mkdirSync("public/models", { recursive: true });
fs.writeFileSync("public/models/quad.glb", Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]));
console.log("wrote public/models/quad.glb", 12 + 16 + json.length + bin.length, "bytes");
