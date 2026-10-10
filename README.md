# bbl3d

Replay a Betaflight blackbox log in 3D: drop a `.bbl`/`.bfl` file, pick a
log, and watch the flight on a 3D map with chase, FPV, orbit and top-down
cameras, an OSD-style HUD, stick positions, a timeline of flight modes and
events, and synced charts of any logged field.

Everything runs in the browser; logs are never uploaded.

## Run

Needs Node 20.19+ (22 LTS recommended; `nvm use` picks it from `.nvmrc`).

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` writes a static site to `dist/` (serve it with
`npm run preview` or any static host).

Keys: <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> ±5 s
(<kbd>Shift</kbd> ±1 s), <kbd>,</kbd>/<kbd>.</kbd> one frame, <kbd>1</kbd>–<kbd>4</kbd>
cameras, <kbd>c</kbd> charts. In charts: drag to zoom, double-click to reset,
click to seek.

## Sample flights

Three synthetic flights ship in `public/samples/` and can be opened from the
start screen or the header's Samples menu: around the Eiffel Tower, the Golden
Gate Bridge and Christ the Redeemer, made for the Google 3D map. They are
generated from planned paths (`scripts/samples/`): thrust direction gives the
attitude, which gives gyro, accelerometer, motors, battery, GPS and baro data,
written as a real Betaflight 4.5-style `.bbl`. Paths were checked against
OpenStreetMap structure positions and the Copernicus GLO-30 surface model.
Regenerate with `npm run samples` (needs Docker for GDAL).

## Maps

Two sources, switchable in the header; neither needs a credit card.

- **Google 3D**: Google Photorealistic 3D Tiles (textured buildings, trees and
  terrain) through a free [Cesium ion](https://ion.cesium.com/signup)
  Community account. Paste its default access token in Settings; it's stored
  only in your browser. The Community plan is for personal, non-commercial
  use and includes about 1000 tileset loads a month.
- **Open data (EE)**: Estonian Land Board orthophoto (Esri World Imagery
  outside Estonia) on keyless AWS terrain tiles, plus untextured LOD2
  buildings and single trees if you build them locally:

  ```bash
  npm run tiles:ee -- --area Tallinn      # needs Docker (GDAL) and ~3 min
  ```

  `--area` is a municipality as named on the geoportal's
  [Download 3D data](https://geoportaal.maaamet.ee/eng/Download-3D-data-p837.html)
  page (`Tallinn`, `Tartu_linn`, `Saue_vald`, …); `--only buildings|trees`
  builds one layer. Output goes to `public/tiles/` (not committed; Tallinn is
  about 300 MB). Buildings and trees are placed on the app's terrain.

## How the flight is reconstructed

- **Parsing** uses the official
  [blackbox-log-viewer](https://github.com/betaflight/blackbox-log-viewer)
  parser, vendored unchanged in `src/parser/vendor/` (see `UPSTREAM.md`), in
  a Web Worker.
- **Flight modes**: since Betaflight 4.0 the `flightModeFlags` field holds
  the mode switches (`rcModeActivationMask`), whose bit order changed in
  2025.12 and 2026.6. `src/flight/modes.ts` decodes it per firmware version
  (the viewer mislabels these for 4.x logs).
- **Position**: GPS fixes interpolated between updates; height is the baro
  altitude above the start point on top of the ground height at home.
- **Attitude**: a GPS-aided complementary filter (`src/flight/attitude.ts`).
  A plain gyro+accelerometer estimate drifts toward level in sustained
  turns, because a multirotor's accelerometer mostly measures thrust; this one
  compares the measured specific force with the acceleration seen by GPS and
  baro, and pulls heading toward the GPS course (no magnetometer needed).

## Tests

```bash
npm test           # unit tests against real logs in fixtures/ (git-ignored)
npm run build
docker run --rm --network host -v "$PWD:/app" -w /app \
  mcr.microsoft.com/playwright:v1.58.0-noble node e2e/smoke.mjs
```

Tests skip when the fixture logs are missing. `fixtures/decoded/*.csv` are
`blackbox_decode --merge-gps` outputs from
[blackbox-tools](https://github.com/betaflight/blackbox-tools).

## Credits and licence

GPL-3.0 (the vendored parser is GPL-3.0). Map data: Google, Cesium ion,
Esri/Maxar/Earthstar Geographics, Mapzen/Tilezen terrain on AWS Open Data,
and Maa- ja Ruumiamet (Estonian Land and Spatial Development Board) open data
for orthophoto, buildings and trees.
