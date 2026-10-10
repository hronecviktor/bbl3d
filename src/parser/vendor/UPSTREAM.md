# Vendored parser

Copied unchanged from https://github.com/betaflight/blackbox-log-viewer `src/`
at commit a84755c5e897c1a3a580424b64c0df066c12c6b4 (2026-09-03), GPL-3.0.

Files: flightlog.js, flightlog_parser.js, flightlog_index.js, datastream.js,
decoders.js, tools.js, flightlog_fielddefs.js, imu.js, gps_transform.js,
cache.js, flightlog_fields_presenter.js.

Local addition: `stores/settings.js`, a stub replacing the viewer's Pinia
settings store.

Known upstream issue: flight-mode names for Betaflight 4.x logs are wrong
(`flightModeFlags` is `rcModeActivationMask`); we decode modes ourselves in
`src/flight/modes.ts`.
