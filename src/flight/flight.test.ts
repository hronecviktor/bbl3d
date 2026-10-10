// Tests against real logs. The fixtures contain GPS positions, so they live in
// the git-ignored fixtures/ folder; the tests are skipped when it's missing.
// fixtures/decoded/*.csv come from blackbox-tools' `blackbox_decode --merge-gps`.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { extractLog, listLogs, openFile } from "../parser/extract";
import { Flight, rad, wrapPi } from "./flight";

const FIX = new URL("../../fixtures/", import.meta.url).pathname;
const have = (f: string) => fs.existsSync(FIX + f);

function load(file: string, index: number) {
  const log = openFile(new Uint8Array(fs.readFileSync(FIX + file)));
  const logs = listLogs(log);
  return { logs, flight: new Flight(extractLog(log, index), logs[index]) };
}

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000;
  const dN = rad(b.lat - a.lat) * R;
  const dE = rad(b.lon - a.lon) * R * Math.cos(rad(a.lat));
  return Math.hypot(dN, dE);
}

describe.skipIf(!have("btfl_013.bbl"))("btfl_013 (flight cut off by full flash)", () => {
  const { logs, flight } = load("btfl_013.bbl", 1);

  it("finds both logs in the file", () => {
    expect(logs).toHaveLength(2);
    expect(logs[1].craftName).toBe("Nazgul F5 V3");
    expect(logs[1].durationS).toBeCloseTo(81.9, 0);
  });

  it("flags the log as cut off", () => {
    expect(flight.cutOff).toBe(true);
  });

  it.skipIf(!have("decoded/btfl_013.02.csv"))("matches blackbox_decode values", () => {
    const lines = fs.readFileSync(FIX + "decoded/btfl_013.02.csv", "utf8").trim().split("\n");
    const head = lines[0].split(",").map((s) => s.trim());
    const col = (n: string) => head.indexOf(n);
    const raw = flight.raw("time")!;
    const byTime = new Map<number, number>();
    raw.forEach((v, i) => byTime.set(v, i));
    let checked = 0;
    for (let r = 1; r < lines.length; r += 997) {
      const row = lines[r].split(",").map((s) => s.trim());
      const i = byTime.get(Number(row[col("time (us)")]));
      if (i === undefined) continue;
      expect(flight.raw("gyroADC[0]")![i]).toBe(Number(row[col("gyroADC[0]")]));
      expect(flight.raw("motor[3]")![i]).toBe(Number(row[col("motor[3]")]));
      expect(flight.raw("baroAlt")![i]).toBe(Number(row[col("baroAlt")]));
      expect(flight.series("vbatLatest")![i]).toBeCloseTo(Number(row[col("vbatLatest (V)")]), 2);
      expect(flight.series("amperageLatest")![i]).toBeCloseTo(Number(row[col("amperageLatest (A)")]), 2);
      const lat = Number(row[col("GPS_coord[0]")]);
      if (lat) {
        expect(flight.series("GPS_coord[0]")![i]).toBeCloseTo(lat, 6);
        expect(flight.series("GPS_speed")![i]).toBeCloseTo(Number(row[col("GPS_speed (m/s)")]), 2);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });
});

describe.skipIf(!have("btfl_006.bbl"))("btfl_006", () => {
  it("decodes the GPS Rescue in log 4 and ends near home", () => {
    const { flight } = load("btfl_006.bbl", 3);
    const rescue = flight.modes.find((m) => m.name === "GPSRESCUE");
    expect(rescue?.start).toBeCloseTo(28.7, 0);
    expect(rescue?.end).toBeCloseTo(flight.duration, 1);
    expect(flight.events.some((e) => e.kind === "disarm")).toBe(true);
    expect(flight.cutOff).toBe(false);
    expect(distM(flight.home!, flight.poseAt(flight.duration)!)).toBeLessThan(10);
  });

  it("decodes turtle mode in log 2", () => {
    const { flight } = load("btfl_006.bbl", 1);
    expect(flight.modes.map((m) => m.name)).toContain("FLIPOVERAFTERCRASH");
  });
});

describe.skipIf(!have("btfl_001.bbl"))("btfl_001 (other quad, angle mode)", () => {
  it("decodes ANGLE from mask 3", () => {
    const { flight } = load("btfl_001.bbl", 0);
    expect(flight.modes.map((m) => m.name)).toEqual(expect.arrayContaining(["ARM", "ANGLE"]));
    expect(flight.gps).toBeNull();
  });
});

describe.skipIf(!have("btfl_010.bbl"))("btfl_010 (6 min cruise)", () => {
  const { flight } = load("btfl_010.bbl", 0);

  it("ends cleanly", () => {
    expect(flight.cutOff).toBe(false);
    expect(flight.events.find((e) => e.kind === "end")?.t).toBeCloseTo(flight.duration, 0);
  });

  it("keeps the fused heading on the GPS course at speed", () => {
    const g = flight.gps!;
    const errs: number[] = [];
    for (let k = 0; k < g.t.length; k++) {
      if (g.speed[k] < 8) continue;
      errs.push(Math.abs(wrapPi(rad(g.course[k]) - flight.poseAt(g.t[k])!.yaw)));
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(rad(15));
  });

  it("banks like a coordinated turn in fast turns", () => {
    // bank ≈ atan(v·ω/g); a gyro+accelerometer-only estimate drifts toward
    // level here (~20° median error), the GPS-aided one shouldn't
    const g = flight.gps!;
    const errs: number[] = [];
    for (let k = 2; k < g.t.length - 2; k++) {
      const dt = g.t[k + 2] - g.t[k - 2];
      if (g.speed[k] < 10 || dt <= 0 || dt > 1) continue;
      const w = wrapPi(rad(g.course[k + 2] - g.course[k - 2])) / dt;
      if (Math.abs(w) < rad(15)) continue;
      const bank = Math.atan((g.speed[k] * w) / 9.81);
      errs.push(Math.abs(flight.poseAt(g.t[k])!.roll - bank));
    }
    errs.sort((a, b) => a - b);
    expect(errs.length).toBeGreaterThan(500);
    expect(errs[errs.length >> 1]).toBeLessThan(rad(12));
  });
});
