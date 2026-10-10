// Display smoothing for the replay: zero-phase Gaussian filtering of the GPS
// track, altitude and attitude. Charts keep showing the raw log.
import { fromEuler, toEuler, type Attitude, type Quat } from "./attitude";

export interface SmoothingLevel {
  label: string;
  track: number; // Gaussian sigma for position and altitude, s
  attitude: number; // Gaussian sigma for orientation, s
}

export const SMOOTHING: SmoothingLevel[] = [
  { label: "Off", track: 0, attitude: 0 },
  { label: "Low", track: 0.2, attitude: 0.02 },
  { label: "Medium", track: 0.5, attitude: 0.05 },
  { label: "High", track: 1.0, attitude: 0.12 },
];

/**
 * Approximate Gaussian blur by three passes of a moving average (O(n)).
 * `sigma` is in samples; ends are padded with the edge value.
 */
export function gaussian<T extends Float32Array | Float64Array>(src: T, sigma: number): T {
  const out = src.slice() as T;
  if (sigma < 0.5 || src.length < 3) return out;
  // three box passes of width w have variance 3 (w² - 1) / 12
  const half = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const n = src.length;
  const tmp = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  let a: Float64Array | T = out;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + a[i];
    for (let i = 0; i < n; i++) {
      const lo = i - half;
      const hi = i + half;
      // clamp the window and count the padded edge values
      let sum = prefix[Math.min(n, hi + 1)] - prefix[Math.max(0, lo)];
      if (lo < 0) sum += -lo * a[0];
      if (hi >= n) sum += (hi - n + 1) * a[n - 1];
      tmp[i] = sum / (2 * half + 1);
    }
    for (let i = 0; i < n; i++) out[i] = tmp[i];
    a = out;
  }
  return out;
}

export function samplesPerSecond(t: ArrayLike<number>) {
  if (t.length < 2) return 1;
  const span = t[t.length - 1] - t[0];
  return span > 0 ? (t.length - 1) / span : 1;
}

/**
 * Smooth orientation on quaternions so flips and the 0/360° heading wrap are
 * handled: neighbouring quaternions are put on the same hemisphere, each
 * component is blurred, and the result renormalised.
 */
export function smoothAttitude(att: Attitude, t: ArrayLike<number>, sigmaSeconds: number): Attitude {
  const n = att.roll.length;
  const sigma = sigmaSeconds * samplesPerSecond(t);
  if (sigma < 0.5) return att;
  const comp = [0, 1, 2, 3].map(() => new Float64Array(n));
  let prev: Quat | null = null;
  for (let i = 0; i < n; i++) {
    let q = fromEuler(att.roll[i], att.pitch[i], att.yaw[i]);
    if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    for (let c = 0; c < 4; c++) comp[c][i] = q[c];
    prev = q;
  }
  const blurred = comp.map((c) => gaussian(c, sigma));
  const out: Attitude = { roll: new Float32Array(n), pitch: new Float32Array(n), yaw: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const q: Quat = [blurred[0][i], blurred[1][i], blurred[2][i], blurred[3][i]];
    const len = Math.hypot(...q) || 1;
    const [r, p, y] = toEuler([q[0] / len, q[1] / len, q[2] / len, q[3] / len]);
    out.roll[i] = r;
    out.pitch[i] = p;
    out.yaw[i] = y;
  }
  return out;
}

/** Uniform Catmull-Rom between p1 and p2 at u ∈ [0, 1]. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}
