// App-wide state. Svelte doesn't proxy class instances, so the large Flight
// object stays a plain reference inside $state.
import type { Flight } from "./flight/flight";
import type { CameraMode } from "./map/mapview";
import type { MapMode } from "./map/layers";
import type { LogSummary } from "./parser/extract";

export interface Prefs {
  mapMode: MapMode;
  ionToken: string;
  stickMode: 1 | 2;
  fpvUptilt: number;
  fpvFov: number;
  chaseDistance: number;
  imperial: boolean;
  smoothing: number; // index into SMOOTHING
}

const PREFS_KEY = "bbl3d.prefs";
const defaults: Prefs = {
  mapMode: "estonia",
  ionToken: "",
  stickMode: 2,
  fpvUptilt: 30,
  fpvFov: 118,
  chaseDistance: 6,
  imperial: false,
  smoothing: 2,
};

function loadPrefs(): Prefs {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private mode etc.; prefs just won't persist
  }
}

export const prefs: Prefs = $state(loadPrefs());

export const app = $state({
  fileName: "",
  logs: [] as LogSummary[],
  pickingLog: false,
  loading: "" as string, // non-empty while busy; the text is shown
  error: "",
  note: "", // map notes (fallbacks, missing data)
  t: 0, // playback time, s from log start
  playing: false,
  rate: 1,
  camera: "chase" as CameraMode,
  showCharts: true,
  showSettings: false,
});

export const current = $state({ flight: null as Flight | null });
