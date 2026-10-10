// Generates the sample flights in public/samples/ (committed, so the app works
// without running this): one .bbl per flight plus samples.json for the app.
//
//   npm run samples
import fs from "node:fs";
import path from "node:path";
import { FLIGHTS } from "./flights.mjs";
import { simulate, writeLog } from "./synth.mjs";

const OUT = path.resolve("public/samples");
fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
let seed = 1;
for (const make of FLIGHTS) {
  const f = await make();
  const frames = simulate(f.plan);
  const bbl = writeLog(frames, f.site, seed++);
  const file = `${f.id}.bbl`;
  fs.writeFileSync(path.join(OUT, file), bbl);
  // sanity stats for the plan
  let maxAcc = 0;
  let maxSpeed = 0;
  let maxAlt = -Infinity;
  for (const fr of frames) {
    maxAcc = Math.max(maxAcc, Math.hypot(...fr.f));
    maxSpeed = Math.max(maxSpeed, Math.hypot(...fr.v));
    maxAlt = Math.max(maxAlt, fr.p[2]);
  }
  const duration = frames[frames.length - 1].t;
  console.log(
    `${file}: ${duration.toFixed(0)} s, max ${(maxSpeed * 3.6).toFixed(0)} km/h, ` +
      `max specific force ${(maxAcc / 9.81).toFixed(1)} g, max height ${maxAlt.toFixed(0)} m, ${(bbl.length / 1e6).toFixed(1)} MB`,
  );
  manifest.push({
    id: f.id,
    title: f.title,
    description: f.description,
    file,
    duration: Math.round(duration),
    ...(f.hidden ? { hidden: true } : {}),
  });
}
fs.writeFileSync(path.join(OUT, "samples.json"), JSON.stringify(manifest, null, 2) + "\n");
