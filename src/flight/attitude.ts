// GPS-aided attitude estimation.
//
// The blackbox has gyro and accelerometer data but (before 2025.12) no logged
// attitude. A plain gyro+accelerometer filter, like the one in the log viewer,
// assumes the accelerometer measures gravity. On a multirotor in sustained
// turns or acceleration it mostly measures thrust, so the estimate collapses
// toward level (we measured ~20° median bank error in turns).
//
// This is a Mahony complementary filter that instead compares the measured
// specific force with the one expected from GPS/baro motion: f = a - g in the
// world frame. Heading is pulled toward the GPS ground course when moving.
//
// Frames: body is Betaflight's sensor frame, x forward, y left, z up (accZ is
// +1 g at rest). World is east-north-up.

export interface AttitudeInput {
  t: Float64Array; // s
  gyro: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]; // deg/s
  acc: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]; // in g
  // world-frame acceleration of the craft (m/s²), or null without GPS
  accelWorld: ((i: number) => [number, number, number]) | null;
  // GPS ground course (rad, compass) at frame i when trustworthy, else NaN
  course: (i: number) => number;
}

export interface Attitude {
  roll: Float32Array; // rad, right wing down positive
  pitch: Float32Array; // rad, nose up positive
  yaw: Float32Array; // rad, compass heading
}

const G = 9.80665;
const KP_TILT = 1.2; // rad/s per unit of tilt error
const KI_TILT = 0.05;
const KP_YAW = 0.6; // rad/s per rad of heading error
const DEG = Math.PI / 180;

export type Quat = [number, number, number, number]; // w, x, y, z; rotates body → world

function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q;
  // v' = q v q*
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function rotateInv(q: Quat, v: [number, number, number]) {
  return rotate([q[0], -q[1], -q[2], -q[3]], v);
}

function normalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Integrate body rates (rad/s) over dt with the exact exponential map. */
function integrate(q: Quat, wx: number, wy: number, wz: number, dt: number): Quat {
  const rate = Math.hypot(wx, wy, wz);
  if (rate * dt < 1e-12) return q;
  const s = Math.sin((rate * dt) / 2) / rate;
  return normalize(mul(q, [Math.cos((rate * dt) / 2), wx * s, wy * s, wz * s]));
}

function mul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function axisAngle(axis: 0 | 1 | 2, angle: number): Quat {
  const q: Quat = [Math.cos(angle / 2), 0, 0, 0];
  q[axis + 1] = Math.sin(angle / 2);
  return q;
}

export function fromEuler(roll: number, pitch: number, yaw: number): Quat {
  // Intrinsic z-y-x in ENU/FLU: turn so the nose points at the compass
  // heading (azimuth π/2 - yaw from east), pitch nose up (a negative rotation
  // about +y, which points left), then roll right wing down (+x).
  return normalize(mul(mul(axisAngle(2, Math.PI / 2 - yaw), axisAngle(1, -pitch)), axisAngle(0, roll)));
}

export function toEuler(q: Quat): [number, number, number] {
  const fwd = rotate(q, [1, 0, 0]);
  const left = rotate(q, [0, 1, 0]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd[2])));
  // heading of the nose; when pointing straight up/down fall back to the up axis
  const yaw = Math.atan2(fwd[0], fwd[1]);
  // roll: angle of the left axis above the horizontal plane, right-wing-down positive
  const up = rotate(q, [0, 0, 1]);
  const roll = Math.atan2(left[2], up[2]);
  return [roll, pitch, (yaw + 2 * Math.PI) % (2 * Math.PI)];
}

export function estimateAttitude(inp: AttitudeInput): Attitude {
  const n = inp.t.length;
  const out: Attitude = { roll: new Float32Array(n), pitch: new Float32Array(n), yaw: new Float32Array(n) };
  if (!n) return out;

  // initial tilt from the accelerometer at rest; heading from the first usable course
  const a0: [number, number, number] = [inp.acc[0][0], inp.acc[1][0], inp.acc[2][0]];
  const roll0 = Math.atan2(a0[1], a0[2]);
  const pitch0 = Math.atan2(a0[0], Math.hypot(a0[1], a0[2]));
  let q = fromEuler(roll0, pitch0, initialYaw(inp));
  let bias: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const dt = i ? Math.min(0.05, Math.max(0, inp.t[i] - inp.t[i - 1])) : 0;
    let wx = inp.gyro[0][i] * DEG;
    let wy = inp.gyro[1][i] * DEG;
    let wz = inp.gyro[2][i] * DEG;

    // --- tilt correction from the specific force ---
    const fm: [number, number, number] = [inp.acc[0][i], inp.acc[1][i], inp.acc[2][i]];
    const fmN = Math.hypot(...fm);
    const aw = inp.accelWorld ? inp.accelWorld(i) : [0, 0, 0];
    // expected specific force in world (g units), then into the body frame
    const fe = rotateInv(q, [aw[0] / G, aw[1] / G, aw[2] / G + 1]);
    const feN = Math.hypot(...fe);
    // skip when the sensor clips or the model clearly doesn't fit (crash, impact)
    if (fmN > 0.2 && fmN < 6 && feN > 0.2 && Math.abs(fmN - feN) < 1.5) {
      const ex = (fm[1] * fe[2] - fm[2] * fe[1]) / (fmN * feN);
      const ey = (fm[2] * fe[0] - fm[0] * fe[2]) / (fmN * feN);
      const ez = (fm[0] * fe[1] - fm[1] * fe[0]) / (fmN * feN);
      bias = [bias[0] + KI_TILT * ex * dt, bias[1] + KI_TILT * ey * dt, bias[2] + KI_TILT * ez * dt];
      // gyro would rotate fm toward fe: correction is fm × fe
      wx += KP_TILT * ex + bias[0];
      wy += KP_TILT * ey + bias[1];
      wz += KP_TILT * ez + bias[2];
    }

    // --- heading correction from the GPS course (rotation about world up) ---
    const course = inp.course(i);
    if (!Number.isNaN(course)) {
      const yaw = toEuler(q)[2];
      const err = Math.atan2(Math.sin(course - yaw), Math.cos(course - yaw));
      // compass heading grows clockwise, i.e. a negative rotation about world up
      const [bx, by, bz] = rotateInv(q, [0, 0, -KP_YAW * err]);
      wx += bx;
      wy += by;
      wz += bz;
    }

    q = integrate(q, wx, wy, wz, dt);
    const [r, p, y] = toEuler(q);
    out.roll[i] = r;
    out.pitch[i] = p;
    out.yaw[i] = y;
  }
  return out;
}

/** Heading at t=0: first trustworthy course minus the gyro yaw turned until then. */
function initialYaw(inp: AttitudeInput): number {
  let turned = 0;
  for (let i = 1; i < inp.t.length; i++) {
    const c = inp.course(i);
    // world yaw rate ≈ -gyroZ while near level (compass grows clockwise)
    turned -= inp.gyro[2][i] * DEG * (inp.t[i] - inp.t[i - 1]);
    if (!Number.isNaN(c)) return c - turned;
  }
  return 0;
}
