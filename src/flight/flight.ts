// The Flight model: columnar log data plus everything derived from it that the
// map, HUD, timeline and charts need (units, GPS samples, fused heading, modes,
// events).
import type { ExtractedLog, LogSummary } from "../parser/extract";
import { boxNames, decodeModes, modeIntervals, type ModeInterval } from "./modes";

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

const GPS_FUSION_MIN_SPEED = 5; // m/s
const GPS_FUSION_TAU = 4; // s, time constant of the heading-offset filter

export class Flight {
  readonly summary: LogSummary;
  readonly sysConfig: Record<string, any>;
  readonly fieldNames: string[];
  readonly t: Float64Array; // s from log start
  readonly duration: number;
  readonly gps: GpsTrack | null;
  readonly home: { lat: number; lon: number } | null;
  readonly modes: ModeInterval[];
  readonly events: FlightEvent[];
  readonly cutOff: boolean;
  readonly boxNames: string[] | null;
  /** Heading after pulling the IMU estimate onto the GPS course, rad. */
  readonly yaw: Float32Array;
  /** Altitude above the home point, m (baro when logged, else GPS). */
  readonly relAlt: Float32Array;

  private cols = new Map<string, Float32Array | Float64Array>();
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
    this.yaw = this.fuseHeading();
    this.relAlt = this.buildRelAlt();
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

  poseAt(t: number): Pose | null {
    const g = this.gps;
    if (!g || !g.t.length) return null;
    const i = this.indexAt(t);
    const j = Math.min(i + 1, this.t.length - 1);
    const span = this.t[j] - this.t[i];
    const k = span > 0 ? Math.min(1, Math.max(0, (t - this.t[i]) / span)) : 0;
    const lerp = (a: ArrayLike<number>) => a[i] + (a[j] - a[i]) * k;
    const lerpAngle = (a: ArrayLike<number>) => a[i] + wrapPi(a[j] - a[i]) * k;
    const roll = this.cols.get("heading[0]");
    const pitch = this.cols.get("heading[1]");

    // GPS position, interpolated between fixes
    let gi = upperBound(g.t, t) - 1;
    let lat: number, lon: number;
    if (gi < 0) {
      lat = g.lat[0];
      lon = g.lon[0];
    } else if (gi >= g.t.length - 1) {
      gi = g.t.length - 1;
      lat = g.lat[gi];
      lon = g.lon[gi];
    } else {
      const gk = (t - g.t[gi]) / (g.t[gi + 1] - g.t[gi]);
      lat = g.lat[gi] + (g.lat[gi + 1] - g.lat[gi]) * gk;
      lon = g.lon[gi] + (g.lon[gi + 1] - g.lon[gi]) * gk;
    }
    return {
      lat,
      lon,
      relAlt: lerp(this.relAlt),
      roll: roll ? lerpAngle(roll) : 0,
      // the IMU estimate is positive nose-down
      pitch: pitch ? -lerpAngle(pitch) : 0,
      yaw: lerpAngle(this.yaw),
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

  /**
   * Without a magnetometer the IMU heading has an arbitrary start offset and
   * drifts. When moving fast enough, ground course is a good heading reference,
   * so estimate the offset from it with a zero-phase (forward + backward)
   * first-order filter and add it to the IMU heading.
   */
  private fuseHeading(): Float32Array {
    const n = this.t.length;
    const imu = this.cols.get("heading[2]");
    const out = new Float32Array(n);
    if (!imu) return out;
    const g = this.gps;
    if (!g) {
      out.set(imu);
      return out;
    }
    // offset measurements at each GPS fix while moving
    const meas = new Float64Array(n).fill(NaN);
    let fix = 0;
    for (let i = 0; i < n; i++) {
      while (fix + 1 < g.t.length && g.t[fix + 1] <= this.t[i]) fix++;
      if (g.t[fix] === this.t[i] && g.speed[fix] >= GPS_FUSION_MIN_SPEED) {
        meas[i] = wrapPi(rad(g.course[fix]) - imu[i]);
      }
    }
    const first = meas.findIndex((v) => !Number.isNaN(v));
    if (first < 0) {
      out.set(imu);
      return out;
    }
    const pass = (from: number, to: number, step: number) => {
      const est = new Float64Array(n);
      let o = meas[first];
      let lastT = this.t[from];
      for (let i = from; i !== to; i += step) {
        if (!Number.isNaN(meas[i])) {
          // weight each fix by the time since the previous one
          const dt = Math.min(1, Math.max(0.05, Math.abs(this.t[i] - lastT)));
          o += wrapPi(meas[i] - o) * (1 - Math.exp(-dt / GPS_FUSION_TAU));
          lastT = this.t[i];
        }
        est[i] = o;
      }
      return est;
    };
    const fwd = pass(0, n, 1);
    const bwd = pass(n - 1, -1, -1);
    for (let i = 0; i < n; i++) {
      const o = fwd[i] + wrapPi(bwd[i] - fwd[i]) / 2;
      out[i] = wrap2Pi(imu[i] + o);
    }
    return out;
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
