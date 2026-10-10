// The Flight model: columnar log data plus everything derived from it that the
// map, HUD, timeline and charts need (units, GPS samples, fused heading, modes,
// events).
import type { ExtractedLog, LogSummary } from "../parser/extract";
import { estimateAttitude, type Attitude } from "./attitude";
import { boxNames, decodeModes, modeIntervals, type ModeInterval } from "./modes";
import { SMOOTHING, catmullRom, gaussian, samplesPerSecond, smoothAttitude } from "./smooth";

export const EVENT = { SYNC_BEEP: 0, INFLIGHT_ADJUSTMENT: 13, LOGGING_RESUME: 14, DISARM: 15, FLIGHT_MODE: 30, LOG_END: 255 };

const DISARM_REASON = [
  "arming disabled", "failsafe", "throttle timeout", "sticks", "switch",
  "crash protection", "runaway takeoff", "GPS Rescue", "serial IO",
];

export const FAILSAFE_PHASE = ["idle", "RX loss detected", "landing", "landed", "GPS Rescue"];

export interface FlightEvent {
  t: number; // s from log start
  kind: "arm" | "disarm" | "end" | "resume" | "adjust";
  label: string;
}

export interface GpsTrack {
  t: Float64Array; // s from log start, one entry per GPS update
  lat: Float64Array; // degrees
  lon: Float64Array;
  alt: Float32Array; // m, GPS altitude (MSL)
  speed: Float32Array; // m/s
  course: Float32Array; // degrees, 0 = north, clockwise
  sats: Float32Array;
}

export interface Pose {
  lat: number;
  lon: number;
  relAlt: number; // m above the home point
  roll: number; // rad, right wing down positive
  pitch: number; // rad, nose up positive
  yaw: number; // rad, 0 = north, clockwise
}

/** What poseAt draws from: raw or smoothed copies of the track and attitude. */
interface PoseSource {
  lat: Float64Array; // per GPS fix
  lon: Float64Array;
  relAlt: Float32Array; // per frame
  attitude: Attitude;
  curved: boolean; // Catmull-Rom between fixes instead of straight lines
}

const COURSE_MIN_SPEED = 5; // m/s; below this the GPS course is too noisy for heading

export class Flight {
  readonly summary: LogSummary;
  readonly sysConfig: Record<string, any>;
  fieldNames: string[];
  readonly t: Float64Array; // s from log start
  readonly duration: number;
  readonly gps: GpsTrack | null;
  readonly home: { lat: number; lon: number } | null;
  readonly modes: ModeInterval[];
  readonly events: FlightEvent[];
  readonly cutOff: boolean;
  readonly boxNames: string[] | null;
  /** GPS-aided attitude estimate (see attitude.ts), rad. */
  readonly attitude: Attitude;
  /** Altitude above the home point, m (baro when logged, else GPS). */
  readonly relAlt: Float32Array;
  /** Charge used since log start, mAh (integrated current). */
  readonly mAh: Float32Array | null;
  /** Battery cell count estimated from the starting voltage. */
  readonly cells: number;

  private cols = new Map<string, Float32Array | Float64Array>();
  private sources = new Map<number, PoseSource>();
  private source!: PoseSource;
  /** Index into SMOOTHING used by poseAt. */
  smoothing = 0;
  private converted = new Map<string, Float32Array | Float64Array>();

  constructor(x: ExtractedLog, summary: LogSummary) {
    this.summary = summary;
    this.sysConfig = x.sysConfig;
    this.fieldNames = x.fieldNames;
    x.fieldNames.forEach((n, i) => this.cols.set(n, x.columns[i]));
    const t0 = x.time[0] ?? 0;
    this.t = x.time.map((v) => (v - t0) / 1e6);
    this.duration = this.t.length ? this.t[this.t.length - 1] : 0;

    this.boxNames = boxNames(Number(this.sysConfig.firmwareType), String(this.sysConfig.firmwareVersion ?? ""));
    const mask = this.cols.get("flightModeFlags");
    this.modes = mask ? modeIntervals(this.t, mask, this.boxNames) : [];

    this.gps = this.buildGps();
    this.home = this.findHome();
    this.events = this.buildEvents(x, t0);
    this.cutOff = !x.events.some((e) => e.type === EVENT.LOG_END);
    this.relAlt = this.buildRelAlt();
    this.attitude = this.buildAttitude();
    // expose the estimate to charts, in degrees
    const deg = (a: Float32Array) => a.map((v) => (v * 180) / Math.PI);
    this.cols.set("attitude.roll", deg(this.attitude.roll));
    this.cols.set("attitude.pitch", deg(this.attitude.pitch));
    this.cols.set("attitude.heading", deg(this.attitude.yaw));
    this.fieldNames = [...this.fieldNames, "attitude.roll", "attitude.pitch", "attitude.heading"];
    this.setSmoothing(0);
    this.mAh = this.buildMah();
    this.cells = this.estimateCells();
  }

  has(name: string) {
    return this.cols.has(name);
  }

  /** Raw logged values, as the firmware wrote them. */
  raw(name: string): Float32Array | Float64Array | undefined {
    return this.cols.get(name);
  }

  /** Values in display units (see unitOf). */
  series(name: string): Float32Array | Float64Array | undefined {
    const cached = this.converted.get(name);
    if (cached) return cached;
    const raw = this.cols.get(name);
    if (!raw) return undefined;
    const f = this.converter(name);
    // keep 64-bit columns (GPS coordinates) 64-bit
    const out = raw instanceof Float64Array ? new Float64Array(raw.length) : new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = f(raw[i]);
    this.converted.set(name, out);
    return out;
  }

  unitOf(name: string): string {
    const base = name.replace(/\[\d+\]$/, "");
    return UNITS[base] ?? "";
  }

  private converter(name: string): (v: number) => number {
    const base = name.replace(/\[\d+\]$/, "");
    const poles = Number(this.sysConfig.motor_poles) || 14;
    const motorMin = Number(this.sysConfig.motorOutput?.[0] ?? 0);
    const motorMax = Number(this.sysConfig.motorOutput?.[1] ?? 2047);
    switch (base) {
      case "vbatLatest":
        return (v) => v / 100;
      case "amperageLatest":
        return (v) => v / 100;
      case "baroAlt":
        return (v) => v / 100;
      case "GPS_coord":
        return (v) => v / 1e7;
      case "GPS_altitude":
        return (v) => v / 10;
      case "GPS_speed":
        return (v) => v / 100;
      case "GPS_ground_course":
        return (v) => v / 10;
      case "heading":
        return (v) => (v * 180) / Math.PI;
      case "rcCommand":
        // roll/pitch/yaw are logged around 0; show them as µs like throttle
        return name === "rcCommand[3]" ? (v) => v : (v) => v + 1500;
      case "motor":
        return (v) => ((v - motorMin) / (motorMax - motorMin)) * 100;
      case "eRPM":
        return (v) => (v * 200) / poles;
      case "rssi":
        return (v) => (v / 1024) * 100;
      default:
        return (v) => v;
    }
  }

  /** Index of the last frame at or before time t (s). */
  indexAt(t: number): number {
    const a = this.t;
    let lo = 0;
    let hi = a.length - 1;
    if (t <= a[0]) return 0;
    if (t >= a[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Linearly interpolated converted value at time t. */
  valueAt(name: string, t: number): number {
    const s = this.series(name);
    if (!s) return NaN;
    const i = this.indexAt(t);
    const j = Math.min(i + 1, s.length - 1);
    const span = this.t[j] - this.t[i];
    const k = span > 0 ? Math.min(1, Math.max(0, (t - this.t[i]) / span)) : 0;
    return s[i] + (s[j] - s[i]) * k;
  }

  activeModes(t: number): string[] {
    const mask = this.cols.get("flightModeFlags");
    if (!mask) return [];
    return decodeModes(mask[this.indexAt(t)] | 0, this.boxNames);
  }

  /** Pick the display smoothing (index into SMOOTHING); results are cached per level. */
  setSmoothing(level: number) {
    const lvl = Math.max(0, Math.min(SMOOTHING.length - 1, level));
    this.smoothing = lvl;
    let src = this.sources.get(lvl);
    if (!src) {
      const { track, attitude } = SMOOTHING[lvl];
      const g = this.gps;
      const fixRate = g ? samplesPerSecond(g.t) : 1;
      src = {
        lat: g ? gaussian(g.lat, track * fixRate) : new Float64Array(),
        lon: g ? gaussian(g.lon, track * fixRate) : new Float64Array(),
        relAlt: gaussian(this.relAlt, track * samplesPerSecond(this.t)),
        attitude: smoothAttitude(this.attitude, this.t, attitude),
        curved: track > 0,
      };
      this.sources.set(lvl, src);
    }
    this.source = src;
  }

  /** Times worth sampling to draw the track: every fix, plus in-between points when curved. */
  trackTimes(): number[] {
    const g = this.gps;
    if (!g) return [];
    const sub = this.source.curved ? 4 : 1;
    const out: number[] = [];
    for (let k = 0; k < g.t.length; k++) {
      out.push(g.t[k]);
      if (k + 1 < g.t.length) for (let s = 1; s < sub; s++) out.push(g.t[k] + ((g.t[k + 1] - g.t[k]) * s) / sub);
    }
    return out;
  }

  poseAt(t: number): Pose | null {
    const g = this.gps;
    if (!g || !g.t.length) return null;
    const src = this.source;
    const i = this.indexAt(t);
    const j = Math.min(i + 1, this.t.length - 1);
    const span = this.t[j] - this.t[i];
    const k = span > 0 ? Math.min(1, Math.max(0, (t - this.t[i]) / span)) : 0;
    const lerp = (a: ArrayLike<number>) => a[i] + (a[j] - a[i]) * k;
    const lerpAngle = (a: ArrayLike<number>) => a[i] + wrapPi(a[j] - a[i]) * k;
    const att = src.attitude;

    // GPS position between fixes: straight, or a Catmull-Rom curve when smoothing
    const gi = upperBound(g.t, t) - 1;
    const m = g.t.length;
    let lat: number, lon: number;
    if (gi < 0 || gi >= m - 1) {
      const k0 = gi < 0 ? 0 : m - 1;
      lat = src.lat[k0];
      lon = src.lon[k0];
    } else {
      const gk = (t - g.t[gi]) / (g.t[gi + 1] - g.t[gi]);
      const k0 = Math.max(0, gi - 1);
      const k3 = Math.min(m - 1, gi + 2);
      if (src.curved) {
        lat = catmullRom(src.lat[k0], src.lat[gi], src.lat[gi + 1], src.lat[k3], gk);
        lon = catmullRom(src.lon[k0], src.lon[gi], src.lon[gi + 1], src.lon[k3], gk);
      } else {
        lat = src.lat[gi] + (src.lat[gi + 1] - src.lat[gi]) * gk;
        lon = src.lon[gi] + (src.lon[gi + 1] - src.lon[gi]) * gk;
      }
    }
    return {
      lat,
      lon,
      relAlt: lerp(src.relAlt),
      roll: lerpAngle(att.roll),
      pitch: lerpAngle(att.pitch),
      yaw: lerpAngle(att.yaw),
    };
  }

  private buildGps(): GpsTrack | null {
    const lat = this.cols.get("GPS_coord[0]");
    const lon = this.cols.get("GPS_coord[1]");
    if (!lat || !lon) return null;
    const alt = this.cols.get("GPS_altitude");
    const spd = this.cols.get("GPS_speed");
    const crs = this.cols.get("GPS_ground_course");
    const sat = this.cols.get("GPS_numSat");
    // GPS values are carried forward in every main frame; a new fix is where
    // any of them changes. Frames before the first valid fix are skipped.
    const idx: number[] = [];
    for (let i = 0; i < lat.length; i++) {
      if (!lat[i] || !lon[i] || Number.isNaN(lat[i])) continue;
      const p = idx.length ? idx[idx.length - 1] : -1;
      if (
        p < 0 ||
        lat[i] !== lat[p] ||
        lon[i] !== lon[p] ||
        (spd && spd[i] !== spd[p]) ||
        (alt && alt[i] !== alt[p]) ||
        (crs && crs[i] !== crs[p])
      )
        idx.push(i);
    }
    if (!idx.length) return null;
    const n = idx.length;
    const out: GpsTrack = {
      t: new Float64Array(n),
      lat: new Float64Array(n),
      lon: new Float64Array(n),
      alt: new Float32Array(n),
      speed: new Float32Array(n),
      course: new Float32Array(n),
      sats: new Float32Array(n),
    };
    idx.forEach((i, k) => {
      out.t[k] = this.t[i];
      out.lat[k] = lat[i] / 1e7;
      out.lon[k] = lon[i] / 1e7;
      out.alt[k] = alt ? alt[i] / 10 : 0;
      out.speed[k] = spd ? spd[i] / 100 : 0;
      out.course[k] = crs ? crs[i] / 10 : 0;
      out.sats[k] = sat ? sat[i] : 0;
    });
    return out;
  }

  private findHome() {
    const g = this.gps;
    if (!g) return null;
    // Betaflight sets home at arming; the first fix in the log is the closest
    // we have, but skip fixes with few satellites.
    for (let k = 0; k < g.t.length; k++) {
      if (g.sats[k] >= 5) return { lat: g.lat[k], lon: g.lon[k] };
    }
    return { lat: g.lat[0], lon: g.lon[0] };
  }

  private buildEvents(x: ExtractedLog, t0: number): FlightEvent[] {
    const out: FlightEvent[] = [];
    for (const e of x.events) {
      // the parser can't timestamp events after the last frame; those happen at the end
      const t = Number.isFinite(e.time) ? Math.max(0, (e.time - t0) / 1e6) : this.duration;
      switch (e.type) {
        case EVENT.SYNC_BEEP:
          out.push({ t, kind: "arm", label: "Armed (sync beep)" });
          break;
        case EVENT.DISARM: {
          const reason = DISARM_REASON[Number(e.data.reason)] ?? `reason ${e.data.reason}`;
          out.push({ t, kind: "disarm", label: `Disarmed: ${reason}` });
          break;
        }
        case EVENT.LOG_END:
          out.push({ t, kind: "end", label: "Log end" });
          break;
        case EVENT.LOGGING_RESUME:
          out.push({ t, kind: "resume", label: "Logging resumed" });
          break;
        case EVENT.INFLIGHT_ADJUSTMENT:
          out.push({ t, kind: "adjust", label: `In-flight adjustment ${JSON.stringify(e.data)}` });
          break;
      }
    }
    return out;
  }

  private buildAttitude(): Attitude {
    const n = this.t.length;
    const gyro = [0, 1, 2].map((k) => this.cols.get(`gyroADC[${k}]`));
    const acc = [0, 1, 2].map((k) => this.cols.get(`accSmooth[${k}]`));
    if (gyro.some((c) => !c) || acc.some((c) => !c)) {
      return { roll: new Float32Array(n), pitch: new Float32Array(n), yaw: new Float32Array(n) };
    }
    // raw gyro → deg/s (Betaflight 4+: gyro_scale makes raw = deg/s)
    const gScale = (Number(this.sysConfig.gyroScale) * 1e6 * 180) / Math.PI || 1;
    const one = Number(this.sysConfig.acc_1G) || 2048;
    const scaled = (c: ArrayLike<number>, k: number) => Float32Array.from(c as ArrayLike<number>, (v) => v * k);
    const g = this.gps;
    const fixAt = this.gpsIndexPerFrame();
    const accel = this.worldAcceleration();
    return estimateAttitude({
      t: this.t,
      gyro: gyro.map((c) => scaled(c!, gScale)) as [Float32Array, Float32Array, Float32Array],
      acc: acc.map((c) => scaled(c!, 1 / one)) as [Float32Array, Float32Array, Float32Array],
      accelWorld: accel ? (i) => [accel[0][i], accel[1][i], accel[2][i]] : null,
      course: (i) => {
        const k = fixAt[i];
        return g && k >= 0 && g.speed[k] >= COURSE_MIN_SPEED ? rad(g.course[k]) : NaN;
      },
    });
  }

  /** For each frame, the index of the latest GPS fix (-1 before the first). */
  private gpsIndexPerFrame(): Int32Array {
    const out = new Int32Array(this.t.length).fill(-1);
    const g = this.gps;
    if (!g) return out;
    let k = -1;
    for (let i = 0; i < this.t.length; i++) {
      while (k + 1 < g.t.length && g.t[k + 1] <= this.t[i]) k++;
      out[i] = k;
    }
    return out;
  }

  /**
   * Craft acceleration in east/north/up (m/s²) per frame: horizontal from the
   * GPS velocity (speed + course), vertical from the altitude. Differences
   * span ±0.25 s to keep GPS and baro noise down.
   */
  private worldAcceleration(): [Float32Array, Float32Array, Float32Array] | null {
    const g = this.gps;
    if (!g || g.t.length < 5) return null;
    const m = g.t.length;
    const vE = new Float64Array(m);
    const vN = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      vE[k] = g.speed[k] * Math.sin(rad(g.course[k]));
      vN[k] = g.speed[k] * Math.cos(rad(g.course[k]));
    }
    const fixAcc = (v: Float64Array) => {
      const a = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        let lo = k;
        let hi = k;
        while (lo > 0 && g.t[k] - g.t[lo - 1] <= 0.25) lo--;
        while (hi < m - 1 && g.t[hi + 1] - g.t[k] <= 0.25) hi++;
        const dt = g.t[hi] - g.t[lo];
        a[k] = dt > 0 ? (v[hi] - v[lo]) / dt : 0;
      }
      return a;
    };
    const aE = fixAcc(vE);
    const aN = fixAcc(vN);
    const n = this.t.length;
    const out: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = this.t[i];
      while (k + 1 < m && g.t[k + 1] <= t) k++;
      const k1 = Math.min(k + 1, m - 1);
      const span = g.t[k1] - g.t[k];
      const w = span > 0 ? Math.min(1, Math.max(0, (t - g.t[k]) / span)) : 0;
      out[0][i] = aE[k] + (aE[k1] - aE[k]) * w;
      out[1][i] = aN[k] + (aN[k1] - aN[k]) * w;
    }
    // vertical: second difference of the altitude over ±0.25 s
    const alt = this.relAlt;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      while (this.t[i] - this.t[lo] > 0.25) lo++;
      while (hi < n - 1 && this.t[hi + 1] - this.t[i] <= 0.25) hi++;
      const h1 = this.t[hi] - this.t[i];
      const h0 = this.t[i] - this.t[lo];
      out[2][i] = h0 > 0 && h1 > 0 ? (((alt[hi] - alt[i]) / h1 - (alt[i] - alt[lo]) / h0) * 2) / (h0 + h1) : 0;
    }
    return out;
  }

  private buildMah(): Float32Array | null {
    const amps = this.series("amperageLatest");
    if (!amps) return null;
    const out = new Float32Array(amps.length);
    for (let i = 1; i < amps.length; i++) {
      const dt = this.t[i] - this.t[i - 1];
      out[i] = out[i - 1] + (Math.max(0, amps[i]) * dt * 1000) / 3600;
    }
    return out;
  }

  private estimateCells(): number {
    const v = this.series("vbatLatest");
    if (!v || !v.length) return 0;
    // vbatcellvoltage header max is in 0.01 V; the parser's default (43) in 0.1 V
    const raw = Number(this.sysConfig.vbatmaxcellvoltage);
    const maxCell = raw > 100 ? raw / 100 : raw > 0 ? raw / 10 : 4.35;
    return Math.max(1, Math.ceil(v[Math.min(10, v.length - 1)] / maxCell));
  }

  /** Distance (m) and bearing (rad, compass) from the pose to home. */
  homeVector(p: Pose): { distance: number; bearing: number } | null {
    if (!this.home) return null;
    const R = 6371000;
    const dN = rad(this.home.lat - p.lat) * R;
    const dE = rad(this.home.lon - p.lon) * R * Math.cos(rad(p.lat));
    return { distance: Math.hypot(dN, dE), bearing: Math.atan2(dE, dN) };
  }

  private buildRelAlt(): Float32Array {
    const n = this.t.length;
    const out = new Float32Array(n);
    const baro = this.cols.get("baroAlt");
    if (baro) {
      // baro is relative to its own power-on reference; zero it on the first second
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < n && this.t[i] < 1; i++) {
        sum += baro[i];
        cnt++;
      }
      const ref = cnt ? sum / cnt : baro[0];
      for (let i = 0; i < n; i++) out[i] = (baro[i] - ref) / 100;
      return out;
    }
    const alt = this.cols.get("GPS_altitude");
    if (alt && this.gps) {
      const ref = this.gps.alt[0] * 10;
      for (let i = 0; i < n; i++) out[i] = alt[i] ? (alt[i] - ref) / 10 : 0;
    }
    return out;
  }
}

const UNITS: Record<string, string> = {
  vbatLatest: "V",
  amperageLatest: "A",
  baroAlt: "m",
  GPS_coord: "°",
  GPS_altitude: "m",
  GPS_speed: "m/s",
  GPS_ground_course: "°",
  heading: "°",
  "attitude.roll": "°",
  "attitude.pitch": "°",
  "attitude.heading": "°",
  gyroADC: "°/s",
  gyroUnfilt: "°/s",
  setpoint: "°/s",
  rcCommand: "µs",
  motor: "%",
  eRPM: "rpm",
  rssi: "%",
  gpsDistance: "m",
  gpsCartesianCoords: "m",
  gpsHomeAzimuth: "°",
};

export function rad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function wrapPi(a: number) {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

function wrap2Pi(a: number) {
  return a - 2 * Math.PI * Math.floor(a / (2 * Math.PI));
}

function upperBound(a: Float64Array, v: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
