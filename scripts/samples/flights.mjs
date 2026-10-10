// The three sample flights. Coordinates come from OpenStreetMap (Eiffel Tower
// way 5013364, Golden Gate towers ways 1330049620 / 1330832680) and
// Wikipedia (Cristo Redentor). Paths keep clear of the structures; heights
// are metres above the takeoff point.
import { copernicus } from "./dem.mjs";
import { PathBuilder } from "./synth.mjs";

const R = 6378137;
/** ENU metres of (lat, lon) relative to an origin. */
function enu(origin, lat, lon) {
  return [
    ((lon - origin.lon) * Math.PI * R * Math.cos((origin.lat * Math.PI) / 180)) / 180,
    ((lat - origin.lat) * Math.PI * R) / 180,
  ];
}
const along = (p, headingDeg, d) => [p[0] + d * Math.sin((headingDeg * Math.PI) / 180), p[1] + d * Math.cos((headingDeg * Math.PI) / 180)];

/** Paris: through the legs of the Eiffel Tower, spiral to the summit, flip and dive. */
async function eiffel() {
  const tower = { lat: 48.85826, lon: 2.294501 };
  const axis = 142; // Champ de Mars axis, tower → École Militaire
  const [hE, hN] = along([0, 0], axis, 230);
  const home = {
    lat: tower.lat + (hN / R) * (180 / Math.PI),
    lon: tower.lon + (hE / (R * Math.cos((tower.lat * Math.PI) / 180))) * (180 / Math.PI),
  };
  const c = enu(home, tower.lat, tower.lon);
  const p = new PathBuilder();
  p.hold(2)
    .to([0, 0, 3], 2)
    // low and fast up the Champ de Mars, through the arch between the legs
    .to([...along(c, axis, 120), 16], 16)
    .to([...c, 18], 20)
    .to([...along(c, axis + 180, 110), 26], 20)
    .to([...along(along(c, axis + 180, 140), axis + 90, 40), 34], 18)
    // climbing spiral at 110 m, 1.5 turns, to just under the summit
    .orbit(c, 110, axis + 180 + 40, axis + 180 + 540, 45, 260, 22)
    // summit orbit around the top floor and antenna
    .orbit(c, 55, axis, axis + 360, 285, 295, 15)
    // pop out and up, front flip, dive back down over the Champ de Mars
    .to([...along(c, axis, 85), 315], 12)
    .flip("pitch", 0.6)
    .to([...along(c, axis, 160), 180], 24)
    .to([...along(c, axis, 260), 40], 26)
    .to([...along(c, axis, 320), 18], 20)
    .loop(axis, 24, 18)
    // turn back toward the tower and land at home
    .to([...along(c, axis, 380), 15], 14)
    .to([...along(c, axis, 300), 10], 10)
    .to([0, 0, 4], 8)
    .to([0, 0, 0], 1.2)
    .hold(2);
  return {
    id: "eiffel",
    title: "Eiffel Tower, Paris",
    description: "Through the legs, a spiral climb to the summit, a front flip and a dive with a power loop over the Champ de Mars.",
    plan: p,
    site: { ...home, groundMsl: 34, startTime: "2026-06-21T07:42:10.000+02:00", craftName: "bbl3d sample" },
  };
}

/** San Francisco: under the Golden Gate Bridge deck, over the south tower, dive, and back under. */
async function goldenGate() {
  const home = { lat: 37.8099, lon: -122.4722 }; // shoreline east of Fort Point
  const south = enu(home, 37.814014, -122.477891);
  const north = enu(home, 37.825502, -122.479233);
  const span = Math.hypot(north[0] - south[0], north[1] - south[1]);
  const u = [(north[0] - south[0]) / span, (north[1] - south[1]) / span]; // along the bridge, northward
  const west = [-u[1], u[0]]; // perpendicular, toward the ocean
  const at = (d, side) => [south[0] + u[0] * d + west[0] * side, south[1] + u[1] * d + west[1] * side];
  const bearingFromSouth = (pt) => (Math.atan2(pt[0] - south[0], pt[1] - south[1]) * 180) / Math.PI;
  const axisBearing = (Math.atan2(u[0], u[1]) * 180) / Math.PI; // ≈ -5°
  const p = new PathBuilder();
  p.hold(2)
    .to([0, 0, 3], 2)
    .to([0, 60, 15], 10)
    // out over the water to mid-span, east side, below the deck (≈ 64 m)
    .to([...at(500, -320), 22], 20)
    .to([...at(500, -60), 22], 22)
    .to([...at(500, 0), 22], 22) // under the deck
    .to([...at(500, 160), 30], 22)
    // climb west of the bridge only (cables are low away from the towers)
    .orbit(south, 140, bearingFromSouth(at(500, 160)) , axisBearing - 150, 60, 170, 22)
    .orbit(south, 140, axisBearing - 150, axisBearing - 20, 170, 245, 18)
    // over the tower top (≈ 222 m) and its cable saddles
    .orbit(south, 60, axisBearing - 20, axisBearing - 20 + 360, 255, 255, 15)
    // pop, roll, dive down the ocean side of the tower
    .to([...at(-20, 90), 270], 10)
    .flip("roll", 0.55)
    .to([...at(40, 130), 150], 22)
    .to([...at(120, 150), 60], 22)
    .to([...at(200, 120), 35], 20)
    // back east under the deck, then home
    .to([...at(230, 40), 30], 20)
    .to([...at(240, -60), 28], 20)
    .to([...at(220, -220), 25], 20)
    .to([0, 80, 12], 16)
    .to([0, 0, 4], 8)
    .to([0, 0, 0], 1.2)
    .hold(2);
  return {
    id: "golden-gate",
    title: "Golden Gate Bridge, San Francisco",
    description: "Under the deck at mid-span, a climbing arc to the south tower, an orbit over the tower top, a roll and a dive back under the bridge.",
    plan: p,
    site: { ...home, groundMsl: 3, startTime: "2026-05-14T18:20:00.000-07:00", craftName: "bbl3d sample" },
  };
}

/**
 * Rio de Janeiro: orbit Christ the Redeemer, surf down toward the Lagoa, loop
 * and climb back. Corcovado is a granite spike that 30 m elevation models
 * flatten (they put the summit ~150 m too low), so the takeoff height is the
 * known 700 m, the flight first leaves the spike level (the cliff drops away),
 * and only follows the Copernicus surface model further out, with 60 m margin.
 */
async function cristo() {
  const statue = { lat: -22.951917, lon: -43.210459 }; // OSM node 4919986733
  // terrace south of the statue; the orbit (r = 45 m) starts right above it
  const home = { lat: statue.lat - 45 / 111320, lon: statue.lon };
  const HOME_MSL = 700;
  const dem = copernicus(statue.lat, statue.lon, 2000);
  const c = enu(home, statue.lat, statue.lon);
  const toLatLon = ([e, n]) => [home.lat + (n / R) * (180 / Math.PI), home.lon + (e / (R * Math.cos((home.lat * Math.PI) / 180))) * (180 / Math.PI)];
  const above = (pt, agl) => dem(...toLatLon(pt)) - HOME_MSL + agl;
  const dive = 108; // east-south-east, down toward the Lagoa
  const p = new PathBuilder();
  p.hold(2)
    .to([0, 0, 3], 2)
    .to([0, 0, 30], 6)
    // orbit at chest height (statue 38 m with pedestal, arms span ~28 m)
    .orbit(c, 45, 180, 540, 30, 36, 13)
    // leave the spike level, then descend while the ground falls away
    .to([...along(c, dive, 150), 25], 18)
    .to([...along(c, dive, 260), 0], 22);
  for (let d = 320; d <= 1000; d += 60) {
    const pt = along(c, dive, d);
    p.to([...pt, Math.min(p.p[2], above(pt, 60))], 24, 60);
  }
  p.loop(dive, 30, 20);
  // climb back up the ridge, staying high above the trees
  for (let d = 940; d >= 300; d -= 80) {
    const pt = along(c, dive, d);
    p.to([...pt, Math.max(p.p[2], above(pt, 90))], 20, 80);
  }
  p.to([...along(c, dive, 160), 60], 18)
    .orbit(c, 60, dive, dive + 360, 60, 45, 14)
    .to([0, -25, 20], 8)
    .to([0, 0, 4], 6)
    .to([0, 0, 0], 1.2)
    .hold(2);
  return {
    id: "cristo",
    // hidden from the UI until the replay is cleaned up; the log is still generated
    hidden: true,
    title: "Christ the Redeemer, Rio de Janeiro",
    description: "An orbit around the statue, a dive off Corcovado toward the Lagoa, a power loop and the climb back to the summit.",
    plan: p,
    site: { ...home, groundMsl: HOME_MSL, startTime: "2026-08-02T16:05:00.000-03:00", craftName: "bbl3d sample" },
  };
}

export const FLIGHTS = [eiffel, goldenGate, cristo];
