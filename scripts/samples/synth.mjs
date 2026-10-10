// Synthesises a physically consistent 5" quad flight from a planned path:
// position (C2 spline through keyframes) → acceleration → thrust direction →
// attitude (+ scripted flips/rolls) → body rates (gyro), specific force
// (accelerometer), motors, RPM, battery, GPS (10 Hz) and baro, with noise.
// Output is a Betaflight-4.5-shaped blackbox log (see bbl-writer.mjs).
import { BlackboxWriter, P_INTERVAL } from "./bbl-writer.mjs";

const G = 9.80665;
const LOOP_HZ = 4000; // PID loop; one logged frame every P_INTERVAL loops (250 Hz)
const DT = P_INTERVAL / LOOP_HZ;
const ACC_1G = 2048;
const R_EARTH = 6378137;

// ---------------------------------------------------------------- path plan

/**
 * A path is a list of keyframes { t, p: [east, north, up] } in metres
 * relative to the takeoff point. The builder adds keyframes at a given speed,
 * so the times follow from distances.
 */
export class PathBuilder {
  constructor(start = [0, 0, 0]) {
    this.keys = [{ t: 0, p: start }];
    this.flips = [];
  }
  get t() {
    return this.keys[this.keys.length - 1].t;
  }
  get p() {
    return this.keys[this.keys.length - 1].p;
  }
  /** Stay put (on the ground or hovering). */
  hold(seconds) {
    const p = this.p;
    for (let s = 1; s <= Math.ceil(seconds); s++) this.keys.push({ t: this.t + seconds / Math.ceil(seconds), p: [...p] });
    return this;
  }
  /** Straight-ish move to p at speed (the spline rounds the corners). */
  to(p, speed, step = 25) {
    const from = this.p;
    const d = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
    const n = Math.max(1, Math.round(d / step));
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      this.keys.push({ t: this.t + d / n / speed, p: from.map((v, j) => v + (p[j] - v) * k) });
    }
    return this;
  }
  /**
   * Helix around centre [e, n]: from angle a0 to a1 (degrees, compass, i.e.
   * 0 = north of the centre, clockwise), radius r, height z0 → z1.
   */
  orbit(center, r, a0, a1, z0, z1, speed) {
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 12));
    const pt = (a, z) => [center[0] + r * Math.sin((a * Math.PI) / 180), center[1] + r * Math.cos((a * Math.PI) / 180), z];
    const first = pt(a0, z0);
    if (Math.hypot(...first.map((v, j) => v - this.p[j])) > 1) this.to(first, speed);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const p = pt(a0 + (a1 - a0) * k, z0 + (z1 - z0) * k);
      const d = Math.hypot(...p.map((v, j) => v - this.p[j]));
      this.keys.push({ t: this.t + d / speed, p });
    }
    return this;
  }
  /** Vertical loop of radius r in the current direction of travel (heading in degrees). */
  loop(heading, r, speed) {
    const [e, n, u] = this.p;
    const fx = Math.sin((heading * Math.PI) / 180);
    const fy = Math.cos((heading * Math.PI) / 180);
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      // forward then up, over the top, and back down to the start height
      const fwd = r * Math.sin(a) + (i / steps) * r * 0.6; // drift forward so it exits ahead
      const p = [e + fx * fwd, n + fy * fwd, u + r * (1 - Math.cos(a))];
      const d = Math.hypot(...p.map((v, j) => v - this.p[j]));
      this.keys.push({ t: this.t + d / speed, p });
    }
    return this;
  }
  /** A barrel roll / flip around the body x (roll) or y (pitch) axis, starting now. */
  flip(axis, seconds = 0.55, turns = 1) {
    this.flips.push({ t0: this.t, dur: seconds, axis, turns });
    return this;
  }
}

/** Natural cubic spline through (t, y) knots; returns f(t). */
function spline(ts, ys) {
  const n = ts.length;
  const h = [];
  for (let i = 0; i < n - 1; i++) h.push(ts[i + 1] - ts[i]);
  const a = new Float64Array(n);
  const b = new Float64Array(n).fill(1);
  const c = new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    a[i] = h[i - 1] / 6;
    b[i] = (h[i - 1] + h[i]) / 3;
    c[i] = h[i] / 6;
    r[i] = (ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1];
  }
  // Thomas algorithm; m are the second derivatives (0 at the ends)
  for (let i = 1; i < n; i++) {
    const w = a[i] / b[i - 1];
    b[i] -= w * c[i - 1];
    r[i] -= w * r[i - 1];
  }
  const m = new Float64Array(n);
  for (let i = n - 2; i > 0; i--) m[i] = (r[i] - c[i] * m[i + 1]) / b[i];
  let seg = 0;
  return (t) => {
    if (t <= ts[0]) return ys[0];
    if (t >= ts[n - 1]) return ys[n - 1];
    while (seg > 0 && t < ts[seg]) seg--;
    while (seg < n - 2 && t > ts[seg + 1]) seg++;
    const i = seg;
    const A = (ts[i + 1] - t) / h[i];
    const B = (t - ts[i]) / h[i];
    return A * ys[i] + B * ys[i + 1] + ((A ** 3 - A) * m[i] + (B ** 3 - B) * m[i + 1]) * (h[i] ** 2) / 6;
  };
}

// ---------------------------------------------------------------- math

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rotate vector v around unit axis k by angle (Rodrigues). */
function rotate(v, k, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd * (1 - c));
}

/** Deterministic Gaussian noise (so regenerated samples are identical). */
function rng(seed) {
  let s = seed >>> 0;
  const uni = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uni() + 1e-12)) * Math.cos(2 * Math.PI * uni());
}

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ---------------------------------------------------------------- synthesis

/**
 * Turn a plan into per-frame truth: position, velocity, acceleration and the
 * body axes (x forward, y left, z up in ENU).
 */
export function simulate(plan, { endHold = 2 } = {}) {
  const keys = plan.keys;
  const ts = keys.map((k) => k.t);
  const fx = spline(ts, keys.map((k) => k.p[0]));
  const fy = spline(ts, keys.map((k) => k.p[1]));
  const fz = spline(ts, keys.map((k) => k.p[2]));
  const T = ts[ts.length - 1] + endHold;
  const pos = (t) => [fx(t), fy(t), fz(t)];
  const frames = [];
  // nose starts pointing where the flight first goes
  let xPrev = [0, 1, 0];
  for (let t = 0; t <= T; t += 0.1) {
    const v = sub(pos(t + 0.05), pos(t - 0.05));
    if (Math.hypot(v[0], v[1]) > 0.1) {
      xPrev = norm([v[0], v[1], 0]);
      break;
    }
  }
  const MAX_YAW_STEP = ((360 * Math.PI) / 180) * DT; // nose turns at most 360°/s
  const tEnd = ts[ts.length - 1];
  for (let t = 0; t <= T; t += DT) {
    const h = 0.02;
    // keep the difference stencil inside the plan; outside it the quad sits still
    const tc = Math.min(tEnd - h, Math.max(h, t));
    const p = pos(t);
    const v = t < h || t > tEnd - h ? [0, 0, 0] : scale(sub(pos(tc + h), pos(tc - h)), 1 / (2 * h));
    const acc = t < h || t > tEnd - h ? [0, 0, 0] : scale(sub(sub(pos(tc + h), pos(tc)), sub(pos(tc), pos(tc - h))), 1 / (h * h));
    // specific force = acceleration minus gravity (ENU, gravity is -z)
    const f = [acc[0], acc[1], acc[2] + G];
    let z = norm(f);
    // nose along the velocity (projected off the thrust axis), else keep heading
    const vp = sub(v, scale(z, dot(v, z)));
    const held = norm(sub(xPrev, scale(z, dot(xPrev, z))));
    let x = held;
    if (Math.hypot(...vp) > 1.5) {
      // turn toward the direction of travel, rate-limited about the thrust axis
      const target = norm(vp);
      const angle = Math.atan2(dot(cross(held, target), z), dot(held, target));
      x = rotate(held, z, Math.max(-MAX_YAW_STEP, Math.min(MAX_YAW_STEP, angle)));
    }
    let y = cross(z, x);
    // scripted flips and rolls rotate the body on top of that
    let flipping = false;
    for (const fl of plan.flips) {
      const k = (t - fl.t0) / fl.dur;
      if (k <= 0 || k >= 1) continue;
      flipping = true;
      const angle = 2 * Math.PI * fl.turns * smoothstep(k);
      const axis = fl.axis === "roll" ? x : y;
      x = rotate(x, axis, angle);
      y = rotate(y, axis, angle);
      z = rotate(z, axis, angle);
    }
    if (!flipping) xPrev = x;
    frames.push({ t, p, v, acc, f, x, y, z, flipping });
  }
  return frames;
}

/** Body angular rates (rad/s, body x/y/z) from consecutive body axes. */
function bodyRates(a, b, dt) {
  // R_rel = A^T B ≈ I + [ω]× dt, so ω = vee(R_rel - R_rel^T) / (2 dt):
  // ωx from (2,1), ωy from (0,2), ωz from (1,0)
  const A = [a.x, a.y, a.z];
  const B = [b.x, b.y, b.z];
  const r = (i, j) => dot(A[i], B[j]);
  return [(r(2, 1) - r(1, 2)) / (2 * dt), (r(0, 2) - r(2, 0)) / (2 * dt), (r(1, 0) - r(0, 1)) / (2 * dt)];
}

/**
 * Write the frames as a blackbox log.
 * site: { lat, lon, groundMsl, startTime (ISO), craftName }
 */
export function writeLog(frames, site, seed = 1) {
  const noise = rng(seed);
  const main = [
    ["loopIteration", 0], ["time", 0],
    ["axisP[0]", 1], ["axisP[1]", 1], ["axisP[2]", 1],
    ["axisI[0]", 1], ["axisI[1]", 1], ["axisI[2]", 1],
    ["axisD[0]", 1], ["axisD[1]", 1],
    ["axisF[0]", 1], ["axisF[1]", 1], ["axisF[2]", 1],
    ["rcCommand[0]", 1], ["rcCommand[1]", 1], ["rcCommand[2]", 1], ["rcCommand[3]", 0],
    ["setpoint[0]", 1], ["setpoint[1]", 1], ["setpoint[2]", 1], ["setpoint[3]", 1],
    ["vbatLatest", 0], ["amperageLatest", 1], ["baroAlt", 1], ["rssi", 0],
    ["gyroADC[0]", 1], ["gyroADC[1]", 1], ["gyroADC[2]", 1],
    ["gyroUnfilt[0]", 1], ["gyroUnfilt[1]", 1], ["gyroUnfilt[2]", 1],
    ["accSmooth[0]", 1], ["accSmooth[1]", 1], ["accSmooth[2]", 1],
    ["motor[0]", 0], ["motor[1]", 0], ["motor[2]", 0], ["motor[3]", 0],
    ["eRPM[0]", 0], ["eRPM[1]", 0], ["eRPM[2]", 0], ["eRPM[3]", 0],
  ].map(([name, signed]) => ({ name, signed: !!signed }));
  const gpsFields = [
    ["time", 0], ["GPS_numSat", 0], ["GPS_coord[0]", 1], ["GPS_coord[1]", 1],
    ["GPS_altitude", 1], ["GPS_speed", 0], ["GPS_ground_course", 0],
  ].map(([name, signed]) => ({ name, signed: !!signed }));
  const home = [{ name: "GPS_home[0]", signed: true }, { name: "GPS_home[1]", signed: true }];
  const slow = ["flightModeFlags", "stateFlags", "failsafePhase", "rxSignalReceived", "rxFlightChannelsValid"].map((name) => ({ name, signed: false }));

  const w = new BlackboxWriter({ headers: headerLines(site), main, gps: gpsFields, home, slow });
  const t0us = 5_000_000;
  const toLatLon = (e, n) => [
    site.lat + (n / R_EARTH) * (180 / Math.PI),
    site.lon + (e / (R_EARTH * Math.cos((site.lat * Math.PI) / 180))) * (180 / Math.PI),
  ];

  w.syncBeep(t0us);
  w.slowFrame([1, 7, 0, 1, 1]); // armed, GPS fix + home
  w.homeFrame([Math.round(site.lat * 1e7), Math.round(site.lon * 1e7)]);

  // slowly wandering errors: GPS position, baro drift
  let gpsErrE = 0;
  let gpsErrN = 0;
  let mAh = 0;
  let iTerm = [0, 0, 0];
  let prevRates = [0, 0, 0];
  let prevSet = [0, 0, 0];
  const lead = Math.round(0.015 / DT); // setpoint leads gyro by ~15 ms
  const rates = frames.map((fr, i) => (i === 0 ? [0, 0, 0] : bodyRates(frames[i - 1], fr, DT)));

  frames.forEach((fr, i) => {
    const iteration = i * P_INTERVAL;
    const timeUs = t0us + Math.round(fr.t * 1e6);
    const w3 = rates[i];
    const gyroDps = w3.map((r) => (r * 180) / Math.PI);
    const setDps = (rates[Math.min(frames.length - 1, i + lead)] ?? w3).map((r) => (r * 180) / Math.PI);
    const alpha = w3.map((r, k) => (r - prevRates[k]) / DT); // rad/s²
    prevRates = w3;

    // thrust along body z; during flips the pilot chops throttle
    const thrustAccel = Math.max(0, dot(fr.f, fr.z));
    const onGround = fr.p[2] < 0.05 && Math.hypot(...fr.v) < 0.2;
    let thr = onGround ? 0 : Math.min(1, Math.sqrt(thrustAccel / (6 * G)));
    if (fr.flipping) thr = 0.12;
    const mix = [
      // Betaflight quad X: 1 rear-right, 2 front-right, 3 rear-left, 4 front-left
      [-1, +1, -1],
      [-1, -1, +1],
      [+1, +1, +1],
      [+1, -1, -1],
    ];
    const motors = mix.map((m) => {
      const d = (m[0] * alpha[0] + m[1] * alpha[1] + m[2] * alpha[2] * 0.3) * 0.0015;
      const frac = onGround ? 0.025 : Math.min(1, Math.max(0.025, 0.05 + 0.95 * thr + d + noise() * 0.004));
      return frac;
    });
    const motorOut = motors.map((m) => 48 + (2047 - 48) * m);
    const erpm = motors.map((m) => (onGround && thr === 0 ? 0 : ((32000 * m ** 0.9 * 7) / 100) * (1 + noise() * 0.003)));

    const amps = onGround ? 0.6 : 1.5 + 115 * thr ** 2.2;
    mAh += (amps * DT * 1000) / 3600;
    const volts = 25.0 - 3.2 * (mAh / 1500) - 0.022 * amps + noise() * 0.01;

    // sensors in Betaflight's frame (x forward, y left, z up)
    const vib = Math.sin(fr.t * 2 * Math.PI * (motors[0] * 520 + 40)) * 2.5 * thr;
    const gyroUnf = gyroDps.map((g, k) => g + noise() * 1.8 + (k < 2 ? vib : vib * 0.3));
    const gyro = gyroDps.map((g) => g + noise() * 0.6);
    const fb = [dot(fr.f, fr.x), dot(fr.f, fr.y), dot(fr.f, fr.z)].map((v) => (v / G) * ACC_1G + noise() * 40);
    const acc = fb.map((v) => Math.max(-16 * ACC_1G, Math.min(16 * ACC_1G, v)));

    // rates profile: ±670 °/s at full stick
    const rc = setDps.map((s, k) => Math.max(-500, Math.min(500, (s / 670) * 500 * (k === 2 ? -1 : 1))));
    const err = setDps.map((s, k) => s - gyro[k]);
    iTerm = iTerm.map((v, k) => Math.max(-150, Math.min(150, v * 0.999 + err[k] * 0.02)));
    const dSet = setDps.map((s, k) => (s - prevSet[k]) / DT);
    prevSet = setDps;
    const axisP = err.map((e) => e * 0.5);
    const axisD = [0, 1].map((k) => -alpha[k] * 0.02);
    const axisF = dSet.map((d) => Math.max(-500, Math.min(500, d * 0.004)));

    const baro = fr.p[2] + 0.6 * Math.sin(fr.t / 70) + noise() * 0.12;
    const rssi = Math.max(300, 1000 - Math.hypot(fr.p[0], fr.p[1]) * 0.4 + noise() * 8);

    w.mainFrame([
      iteration, timeUs,
      ...axisP, ...iTerm, ...axisD, ...axisF,
      ...rc, 1000 + thr * 1000,
      ...setDps, thr * 1000,
      volts * 100, amps * 100, baro * 100, rssi,
      ...gyro, ...gyroUnf, ...acc,
      ...motorOut, ...erpm,
    ]);

    // 10 Hz GPS with a wandering error and centimetre-level speed noise
    if (i % Math.round(0.1 / DT) === 0) {
      gpsErrE = gpsErrE * 0.97 + noise() * 0.12;
      gpsErrN = gpsErrN * 0.97 + noise() * 0.12;
      const [lat, lon] = toLatLon(fr.p[0] + gpsErrE, fr.p[1] + gpsErrN);
      const speed = Math.hypot(fr.v[0], fr.v[1]);
      const course = ((Math.atan2(fr.v[0], fr.v[1]) * 180) / Math.PI + 360) % 360;
      w.gpsFrame([
        0,
        18 + Math.round(Math.abs(noise())),
        Math.round(lat * 1e7),
        Math.round(lon * 1e7),
        Math.round((site.groundMsl + fr.p[2] + noise() * 0.3) * 10),
        Math.round(Math.max(0, speed + noise() * 0.05) * 100),
        Math.round(course * 10),
      ]);
    }
  });
  w.disarm(4); // switch
  w.logEnd();
  return w.result();
}

function headerLines(site) {
  return [
    ["Firmware type", "Cleanflight"],
    ["Firmware revision", "Betaflight 4.5.2 (024f8e13d) STM32F7X2"],
    ["Firmware date", "Mar 21 2025 00:50:15"],
    ["Board information", "BBL3D SYNTHETIC_SAMPLE"],
    ["Log start datetime", site.startTime],
    ["Craft name", site.craftName],
    ["minthrottle", 1070],
    ["maxthrottle", 2000],
    ["gyro_scale", "0x3f800000"],
    ["motorOutput", "48,2047"],
    ["acc_1G", ACC_1G],
    ["vbat_scale", 110],
    ["vbatcellvoltage", "330,350,422"],
    ["vbatref", 2500],
    ["currentSensor", "0,200"],
    ["looptime", 125],
    ["gyro_sync_denom", 1],
    ["pid_process_denom", 2],
    ["rc_rates", "10,10,10"],
    ["rc_expo", "30,30,30"],
    ["rates", "67,67,67"],
    ["rate_limits", "1998,1998,1998"],
    ["rates_type", 3],
    ["rollPID", "59,85,54"],
    ["pitchPID", "62,89,62"],
    ["yawPID", "59,100,0"],
    ["dshot_bidir", 1],
    ["motor_poles", 14],
    ["motor_pwm_protocol", 6],
    ["debug_mode", 0],
    ["features", 407176328],
    ["gps_provider", 1],
  ];
}
