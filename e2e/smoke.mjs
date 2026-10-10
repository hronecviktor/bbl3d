// End-to-end smoke test: build output served by `vite preview`, driven by
// headless Chromium (software WebGL). Needs fixtures/btfl_006.bbl (a real log,
// not committed) and a built dist/.
//
//   npm run build
//   docker run --rm --network host -v "$PWD:/app" -w /app \
//     mcr.microsoft.com/playwright:v1.58.0-noble node e2e/smoke.mjs
//
// Screenshots go to test-results/.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const FIXTURE = "fixtures/btfl_006.bbl";
const PORT = 4174;
if (!fs.existsSync(FIXTURE)) {
  console.log(`skipped: ${FIXTURE} not found`);
  process.exit(0);
}
fs.mkdirSync("test-results", { recursive: true });

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], {
  stdio: "ignore",
});
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.setInputFiles("input[type=file] >> nth=0", FIXTURE);
  await page.waitForSelector(".dialog .log", { timeout: 30_000 });
  check((await page.locator(".dialog .log").count()) === 5, "file lists 5 logs");

  // log 4 is a GPS Rescue that lands near home
  await page.locator(".dialog .log").nth(3).click();
  await page.waitForSelector(".hud", { timeout: 30_000 });
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight"); // +35 s
  await page.waitForTimeout(500);
  check((await page.locator(".hud").innerText()).includes("GPS Rescue"), "HUD shows GPS Rescue at 0:35");
  check((await page.locator(".timeline .band").count()) >= 1, "timeline shows a mode band");
  check((await page.locator(".chart canvas").count()) >= 2, "charts are drawn");

  for (const [key, cam] of [["1", "chase"], ["2", "fpv"], ["4", "top"]]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `test-results/${cam}.png` });
  }
  check((await page.locator(".cesium-widget-errorPanel").count()) === 0, "Cesium rendered without errors");

  // playback advances
  const before = await page.locator(".timeline .time").innerText();
  await page.keyboard.press(" ");
  await page.waitForTimeout(2000);
  await page.keyboard.press(" ");
  check((await page.locator(".timeline .time").innerText()) !== before, "playback advances the clock");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} finally {
  server.kill();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
