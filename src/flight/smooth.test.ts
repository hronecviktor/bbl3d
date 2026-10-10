import { describe, expect, it } from "vitest";
import { gaussian, smoothAttitude } from "./smooth";

describe("gaussian", () => {
  it("keeps constants and the mean, and removes alternating noise", () => {
    const flat = gaussian(new Float64Array(50).fill(3), 4);
    expect([...flat].every((v) => Math.abs(v - 3) < 1e-9)).toBe(true);
    const noisy = new Float64Array(200).map((_, i) => (i % 2 ? 1 : -1));
    const out = gaussian(noisy, 3);
    expect(Math.max(...out.slice(20, 180).map(Math.abs))).toBeLessThan(0.05);
  });

  it("is a no-op for sigma 0", () => {
    const a = new Float32Array([1, 5, 2]);
    expect([...gaussian(a, 0)]).toEqual([1, 5, 2]);
  });
});

describe("smoothAttitude", () => {
  it("smooths across the 0/360° heading wrap without swinging through 180°", () => {
    const n = 400;
    const t = Float64Array.from({ length: n }, (_, i) => i / 250);
    // heading turns steadily from 350° through north to 10°
    const yaw = Float32Array.from({ length: n }, (_, i) => (((350 + (i / n) * 20) % 360) * Math.PI) / 180);
    const att = { roll: new Float32Array(n), pitch: new Float32Array(n), yaw };
    const s = smoothAttitude(att, t, 0.1);
    for (const y of s.yaw) {
      const deg = (y * 180) / Math.PI;
      expect(deg < 15 || deg > 345).toBe(true);
    }
  });
});

import { liftAboveGround } from "./smooth";

describe("liftAboveGround", () => {
  it("never leaves the path below ground, eases the lift in, and leaves distant parts alone", () => {
    const n = 2000;
    const alt = new Float32Array(n).fill(5);
    // a 30-sample-wide, 12 m tall ridge in the middle
    const ground = Float32Array.from({ length: n }, (_, i) => (Math.abs(i - 1000) < 15 ? 12 : 0));
    const out = liftAboveGround(alt, ground, 200);
    for (let i = 0; i < n; i++) expect(out[i]).toBeGreaterThanOrEqual(ground[i] - 1e-6);
    expect(out[0]).toBe(5);
    expect(out[n - 1]).toBe(5);
    // no jump: the biggest step is far smaller than the 7 m lift
    let step = 0;
    for (let i = 1; i < n; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
    expect(step).toBeLessThan(1);
  });
});
