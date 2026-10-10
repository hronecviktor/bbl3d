// The bundled sample flights, and a ground-truth check of the attitude
// estimator: a synthetic flight is written as a .bbl, parsed back, and the
// estimated attitude compared with the one used to generate the sensors.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FLIGHTS } from "../../scripts/samples/flights.mjs";
import { simulate, writeLog } from "../../scripts/samples/synth.mjs";
import { extractLog, listLogs, openFile } from "../parser/extract";
import { Flight } from "./flight";

const DIR = new URL("../../public/samples/", import.meta.url).pathname;

function parse(bytes: Uint8Array, index = 0) {
  const log = openFile(bytes);
  const logs = listLogs(log);
  return { logs, flight: new Flight(extractLog(log, index), logs[index]) };
}

describe("bundled samples", () => {
  const manifest: { id: string; file: string; duration: number }[] = JSON.parse(fs.readFileSync(DIR + "samples.json", "utf8"));

  it("lists three samples", () => {
    expect(manifest.map((m) => m.id)).toEqual(["eiffel", "golden-gate", "cristo"]);
  });

  for (const m of manifest) {
    it(`${m.id} parses as one armed GPS flight with a clean end`, () => {
      const { logs, flight } = parse(new Uint8Array(fs.readFileSync(DIR + m.file)));
      expect(logs).toHaveLength(1);
      expect(flight.duration).toBeCloseTo(m.duration, -1);
      expect(flight.gps!.t.length).toBeGreaterThan(m.duration * 9);
      expect(flight.modes.some((x) => x.name === "ARM")).toBe(true);
      expect(flight.cutOff).toBe(false);
      expect(flight.events.some((e) => e.kind === "disarm")).toBe(true);
    });
  }
});

describe("attitude estimator against ground truth", () => {
  it("recovers the attitude of a synthetic freestyle flight", async () => {
    const plan = await FLIGHTS[0](); // Eiffel Tower: spiral, flip, dive, loop
    const frames = simulate(plan.plan);
    const { flight } = parse(new Uint8Array(writeLog(frames, plan.site, 7)));
    flight.setAboveGround(false);
    flight.setSmoothing(0);
    const t0 = flight.t[0];
    const tilt: number[] = [];
    const heading: number[] = [];
    for (let i = 0; i < frames.length; i += 50) {
      const fr = frames[i];
      if (fr.flipping || fr.t < 3) continue;
      const pose = flight.poseAt(fr.t + t0)!;
      // tilt error: angle between the estimated and true body up axes
      const { roll, pitch, yaw } = pose;
      const estUp = upAxis(roll, pitch, yaw);
      const dotUp = estUp[0] * fr.z[0] + estUp[1] * fr.z[1] + estUp[2] * fr.z[2];
      tilt.push((Math.acos(Math.min(1, Math.max(-1, dotUp))) * 180) / Math.PI);
      const trueYaw = Math.atan2(fr.x[0], fr.x[1]);
      if (Math.abs(fr.x[2]) < 0.8) {
        const d = Math.atan2(Math.sin(yaw - trueYaw), Math.cos(yaw - trueYaw));
        heading.push((Math.abs(d) * 180) / Math.PI);
      }
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
    expect(median(tilt)).toBeLessThan(4);
    expect(p90(tilt)).toBeLessThan(12);
    expect(median(heading)).toBeLessThan(6);
  });
});

/** Body up axis in ENU for roll (right wing down), pitch (nose up), compass yaw. */
function upAxis(roll: number, pitch: number, yaw: number): [number, number, number] {
  // nose direction and left wing from yaw/pitch, then roll about the nose
  const fwd = [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
  const left0 = [-Math.cos(yaw), Math.sin(yaw), 0];
  const up0 = [
    fwd[1] * left0[2] - fwd[2] * left0[1],
    fwd[2] * left0[0] - fwd[0] * left0[2],
    fwd[0] * left0[1] - fwd[1] * left0[0],
  ];
  // rolling right wing down tips the up axis toward the right (= -left)
  return [0, 1, 2].map((k) => up0[k] * Math.cos(roll) - left0[k] * Math.sin(roll)) as [number, number, number];
}
