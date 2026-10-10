// Flight-mode decoding. Betaflight 4.0+ logs `flightModeFlags` as the first 32
// bits of rcModeActivationMask (blackbox.c loadSlowState), i.e. a bitmask of
// boxId_e values from src/main/fc/rc_modes.h. The enum changed in 2025.12 and
// 2026.6, so the names depend on the firmware version.
import semver from "semver";

const BOX_4X = [
  "ARM", "ANGLE", "HORIZON", "MAG", "HEADFREE", "PASSTHRU", "FAILSAFE", "GPSRESCUE",
  "ANTIGRAVITY", "HEADADJ", "CAMSTAB", "BEEPERON", "LEDLOW", "CALIB", "OSD", "TELEMETRY",
  "SERVO1", "SERVO2", "SERVO3", "BLACKBOX", "AIRMODE", "3D", "FPVANGLEMIX", "BLACKBOXERASE",
  "CAMERA1", "CAMERA2", "CAMERA3", "FLIPOVERAFTERCRASH", "PREARM", "BEEPGPSCOUNT", "VTXPITMODE", "PARALYZE",
];

const BOX_2025_12 = [
  "ARM", "ANGLE", "HORIZON", "MAG", "ALTHOLD", "HEADFREE", "CHIRP", "PASSTHRU",
  "FAILSAFE", "POSHOLD", "GPSRESCUE", "ANTIGRAVITY", "HEADADJ", "CAMSTAB", "BEEPERON", "LEDLOW",
  "CALIB", "OSD", "TELEMETRY", "SERVO1", "SERVO2", "SERVO3", "BLACKBOX", "AIRMODE",
  "3D", "FPVANGLEMIX", "BLACKBOXERASE", "CAMERA1", "CAMERA2", "CAMERA3", "CRASHFLIP", "PREARM",
];

const BOX_2026_6 = [
  "ARM", "ANGLE", "HORIZON", "MAG", "ALTHOLD", "HEADFREE", "CHIRP", "PASSTHRU",
  "FAILSAFE", "POSHOLD", "GPSRESCUE", "AUTOPILOT", "ANTIGRAVITY", "HEADADJ", "CAMSTAB", "BEEPERON",
  "LEDLOW", "CALIB", "OSD", "TELEMETRY", "SERVO1", "SERVO2", "SERVO3", "BLACKBOX",
  "AIRMODE", "3D", "FPVANGLEMIX", "BLACKBOXERASE", "CAMERA1", "CAMERA2", "CAMERA3", "CRASHFLIP",
];

// Modes worth showing on the timeline; the rest are switches like BEEPERON.
export const FLIGHT_MODES = new Set([
  "ANGLE", "HORIZON", "MAG", "ALTHOLD", "HEADFREE", "CHIRP", "PASSTHRU", "FAILSAFE",
  "POSHOLD", "GPSRESCUE", "AUTOPILOT", "FLIPOVERAFTERCRASH", "CRASHFLIP", "AIRMODE",
  "ACROTRAINER", "LAUNCHCONTROL",
]);

export const MODE_LABEL: Record<string, string> = {
  ANGLE: "Angle",
  HORIZON: "Horizon",
  ALTHOLD: "Alt hold",
  POSHOLD: "Pos hold",
  GPSRESCUE: "GPS Rescue",
  AUTOPILOT: "Autopilot",
  FLIPOVERAFTERCRASH: "Turtle",
  CRASHFLIP: "Turtle",
  FAILSAFE: "Failsafe",
  HEADFREE: "Headfree",
  PASSTHRU: "Passthru",
  CHIRP: "Chirp",
  MAG: "Mag",
  AIRMODE: "Air mode",
};

export function boxNames(firmwareType: number, firmwareVersion: string): string[] | null {
  // FIRMWARE_TYPE_BETAFLIGHT = 3; Betaflight 4.x logs say "Cleanflight" in the
  // firmware type header but the viewer maps them to Betaflight.
  if (firmwareType !== 3) return null;
  const v = semver.coerce(firmwareVersion);
  if (!v) return null;
  if (semver.gte(v, "2026.6.0")) return BOX_2026_6;
  if (semver.gte(v, "2025.12.0")) return BOX_2025_12;
  if (semver.gte(v, "4.0.0")) return BOX_4X;
  return null;
}

export function decodeModes(mask: number, names: string[] | null): string[] {
  const out: string[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if (mask & (1 << bit)) out.push(names?.[bit] ?? `BOX${bit}`);
  }
  return out;
}

export interface ModeInterval {
  name: string;
  start: number; // s from log start
  end: number;
}

/** Turn a per-frame mask column into on/off intervals for every active box. */
export function modeIntervals(t: Float64Array, mask: ArrayLike<number>, names: string[] | null): ModeInterval[] {
  const out: ModeInterval[] = [];
  const open = new Map<string, number>();
  let prev = 0;
  for (let i = 0; i < t.length; i++) {
    const m = mask[i] | 0;
    if (m === prev && i > 0) continue;
    const now = new Set(decodeModes(m, names));
    for (const [name, start] of open) {
      if (!now.has(name)) {
        out.push({ name, start, end: t[i] });
        open.delete(name);
      }
    }
    for (const name of now) if (!open.has(name)) open.set(name, t[i]);
    prev = m;
  }
  const last = t.length ? t[t.length - 1] : 0;
  for (const [name, start] of open) out.push({ name, start, end: last });
  return out.sort((a, b) => a.start - b.start);
}
