// Builds Betaflight's Blackbox Explorer (blackbox-log-viewer, GPL-3.0) for
// embedding in bbl3d: clones the pinned upstream commit, applies
// bbl3d-embed.patch (postMessage bridge, relative asset paths, no service
// worker) and builds it into public/blackbox-viewer/.
//
//   npm run viewer
//
// The built viewer is committed so the app works without running this; its
// corresponding source is the upstream commit below plus the patch.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "https://github.com/betaflight/blackbox-log-viewer.git";
const COMMIT = "a84755c5e897c1a3a580424b64c0df066c12c6b4"; // 2026.6.0+, 2026-09-03
const HERE = path.resolve("scripts/blackbox-viewer");
const WORK = path.join(HERE, "work", "blackbox-log-viewer");
const OUT = path.resolve("public/blackbox-viewer");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

if (!fs.existsSync(path.join(WORK, ".git"))) {
  fs.mkdirSync(path.dirname(WORK), { recursive: true });
  run("git", ["clone", "--filter=blob:none", "--no-checkout", REPO, WORK]);
}
run("git", ["-C", WORK, "fetch", "--quiet", "origin", COMMIT]);
run("git", ["-C", WORK, "checkout", "--quiet", "--force", COMMIT]);
run("git", ["-C", WORK, "clean", "--quiet", "-fdx", "-e", "node_modules"]);
run("git", ["-C", WORK, "apply", path.join(HERE, "bbl3d-embed.patch")]);
run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: WORK });
run("npx", ["vite", "build", "--sourcemap", "false", "--emptyOutDir", "--outDir", OUT], {
  cwd: WORK,
  env: { ...process.env, BBL3D_EMBED: "1" },
});
fs.copyFileSync(path.join(WORK, "LICENSE"), path.join(OUT, "LICENSE"));
fs.writeFileSync(
  path.join(OUT, "SOURCE.md"),
  `# Betaflight Blackbox Explorer (embedded build)

Built from ${REPO.replace(/\.git$/, "")} at commit ${COMMIT}
with scripts/blackbox-viewer/bbl3d-embed.patch applied, by
scripts/blackbox-viewer/build.mjs in the bbl3d repository.

Licensed under the GNU General Public License v3.0 (see LICENSE).
Copyright The Betaflight open source project and contributors.
`,
);
console.log(`built ${path.relative(process.cwd(), OUT)}`);
