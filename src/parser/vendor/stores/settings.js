// Stub for the viewer's Pinia settings store (not vendored). The presenter only
// reads display preferences from it; values match the viewer's defaults.
const userSettings = {
  stickMode: 2,
  speedUnits: 1,
  altitudeUnits: 1,
  legendUnits: true,
};

export function useSettingsStore() {
  return { userSettings };
}
