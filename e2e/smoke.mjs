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
// Screenshots are for looking at, not assertions; software WebGL can stall them.
const shot = (page, path) => page.screenshot({ path, timeout: 90_000 }).catch((e) => console.log(`(no screenshot ${path}: ${e.message.split("\n")[0]})`));
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
    await shot(page, `test-results/${cam}.png`);
  }
  // switching smoothing rebuilds the track
  await page.keyboard.press("1");
  for (const level of ["0", "3", "2"]) {
    await page.selectOption("select[aria-label='Smoothing']", level);
    await page.waitForTimeout(1500);
  }
  await shot(page, "test-results/chase-smoothed.png");
  // the above-ground switch is on by default and can be toggled
  const lift = page.locator(".timeline .toggle input");
  check(await lift.isChecked(), "above-ground correction is on by default");
  await lift.uncheck();
  await page.waitForTimeout(1500);
  await lift.check();
  await page.waitForTimeout(1500);
  check((await page.locator(".cesium-widget-errorPanel").count()) === 0, "Cesium rendered without errors");

  // playback advances
  const before = await page.locator(".timeline .time").innerText();
  await page.keyboard.press(" ");
  await page.waitForTimeout(2000);
  await page.keyboard.press(" ");
  check((await page.locator(".timeline .time").innerText()) !== before, "playback advances the clock");

  // the Blackbox Explorer opens the same log and follows the replay clock
  await page.keyboard.press("e");
  await page.waitForSelector("section.explorer[data-synced=true]", { timeout: 60_000 });
  check(true, "Blackbox Explorer loads the log");
  // the explorer's own time field (mm:ss.mmm from the log start)
  const viewerTime = () =>
    page.frameLocator("iframe[title='Betaflight Blackbox Explorer']").locator("input").evaluateAll((els) => {
      const v = els.map((e) => e.value).find((x) => /^\d\d:\d\d\.\d{3}$/.test(x));
      if (!v) return null;
      const [m, sec] = v.split(":");
      return Number(m) * 60 + Number(sec);
    });
  const replayTime = async () => {
    const [m, sec] = (await page.locator(".timeline .time").innerText()).split(" / ")[0].split(":");
    return Number(m) * 60 + Number(sec);
  };
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(2500);
  const [vt, rt] = [await viewerTime(), await replayTime()];
  check(vt !== null && Math.abs(vt - rt) < 0.1, `Explorer follows the replay (${vt} s vs ${rt} s)`);
  await shot(page, "test-results/explorer.png");
  await page.keyboard.press("e");

  // the sample menu offers the visible samples (Rio is hidden) and loads one
  const offered = await page.locator("select[aria-label='Sample flights'] option").allInnerTexts();
  check(offered.length === 3 && !offered.some((o) => o.includes("Rio")), "sample menu offers Paris and San Francisco only");
  await page.selectOption("select[aria-label='Sample flights']", "eiffel");
  await page.waitForFunction(() => document.querySelector("header .file")?.textContent?.includes("Eiffel"), null, { timeout: 30_000 });
  await page.keyboard.press("1");
  await page.waitForTimeout(500);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight"); // 0:30, spiral climb
  await page.waitForTimeout(6000);
  await shot(page, "test-results/sample-eiffel.png");
  check((await page.locator(".hud").innerText()).includes("ARMED"), "sample flight loads from the menu");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} finally {
  server.kill();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
