import { prefs } from "../state.svelte";

export function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

export function fmtSpeed(ms: number) {
  return prefs.imperial ? `${(ms * 2.23694).toFixed(0)} mph` : `${(ms * 3.6).toFixed(0)} km/h`;
}

export function fmtDistance(m: number) {
  if (prefs.imperial) return m > 1609 ? `${(m / 1609.34).toFixed(2)} mi` : `${(m * 3.28084).toFixed(0)} ft`;
  return m > 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}

export function fmtAlt(m: number) {
  return prefs.imperial ? `${(m * 3.28084).toFixed(0)} ft` : `${m.toFixed(1)} m`;
}
