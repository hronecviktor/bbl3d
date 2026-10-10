// Turns a blackbox file into plain, transferable data using the vendored
// blackbox-log-viewer parser. Runs in the parser worker and in unit tests.
import { FlightLog } from "./vendor/flightlog.js";

export interface LogSummary {
  index: number;
  error: string | null;
  startTime: number; // µs, log clock
  endTime: number;
  durationS: number;
  craftName: string;
  firmware: string;
  logStart: string; // "Log start datetime" header
  hasGps: boolean;
}

export interface LogEvent {
  time: number; // µs, log clock
  type: number; // FlightLogEvent
  data: Record<string, unknown>;
}

export interface ExtractedLog {
  index: number;
  fieldNames: string[];
  time: Float64Array; // µs
  // One per field name, same order. GPS coordinates and the loop counter need
  // 64-bit precision; everything else fits a Float32Array.
  columns: (Float32Array | Float64Array)[];
  events: LogEvent[];
  sysConfig: Record<string, unknown>;
}

const WIDE_FIELDS = new Set(["loopIteration", "time", "GPS_coord[0]", "GPS_coord[1]"]);

// Chunks are fetched in windows to keep the viewer's chunk cache small.
const WINDOW_US = 10_000_000;

// The vendored parser logs every header it doesn't know; silence it.
function quietly<T>(fn: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

export function openFile(bytes: Uint8Array) {
  return quietly(() => new FlightLog(bytes));
}

function plainSysConfig(log: any): Record<string, unknown> {
  // The sysConfig object can hold typed arrays and helper objects; keep only
  // what survives structured cloning as plain data.
  return JSON.parse(JSON.stringify(log.getSysConfig()));
}

export function listLogs(log: any): LogSummary[] {
  return quietly(() => listLogsInner(log));
}

function listLogsInner(log: any): LogSummary[] {
  const out: LogSummary[] = [];
  for (let i = 0; i < log.getLogCount(); i++) {
    const error = log.getLogError(i);
    if (error || !log.openLog(i)) {
      out.push({ index: i, error: String(error || "unreadable log"), startTime: 0, endTime: 0, durationS: 0, craftName: "", firmware: "", logStart: "", hasGps: false });
      continue;
    }
    const sc = log.getSysConfig();
    const start = log.getMinTime();
    const end = log.getMaxTime();
    out.push({
      index: i,
      error: null,
      startTime: start,
      endTime: end,
      durationS: (end - start) / 1e6,
      craftName: sc["Craft name"] ?? "",
      firmware: sc["Firmware revision"] ?? "",
      logStart: sc["Log start datetime"] ?? "",
      hasGps: log.hasGpsData(),
    });
  }
  return out;
}

export function extractLog(log: any, index: number): ExtractedLog {
  return quietly(() => extractLogInner(log, index));
}

function extractLogInner(log: any, index: number): ExtractedLog {
  if (!log.openLog(index)) throw new Error(`log ${index + 1} cannot be opened`);
  const fieldNames: string[] = log.getMainFieldNames().slice();
  const start = log.getMinTime();
  const end = log.getMaxTime();

  const frames: number[][] = [];
  const events: LogEvent[] = [];
  const seen = new Set<number>();
  for (let t = start; t <= end; t += WINDOW_US) {
    for (const chunk of log.getChunksInTimeRange(t, Math.min(end, t + WINDOW_US))) {
      if (seen.has(chunk.index)) continue;
      seen.add(chunk.index);
      for (const f of chunk.frames) frames.push(Array.from(f as ArrayLike<number>));
      for (const e of chunk.events) events.push({ time: e.time, type: e.event, data: e.data ?? {} });
    }
  }
  frames.sort((a, b) => a[1] - b[1]);

  const n = frames.length;
  const time = new Float64Array(n);
  const columns = fieldNames.map((name) =>
    WIDE_FIELDS.has(name) ? new Float64Array(n) : new Float32Array(n),
  );
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    time[i] = f[1];
    for (let j = 0; j < fieldNames.length; j++) {
      const v = f[j];
      columns[j][i] = v === undefined || v === null ? NaN : v;
    }
  }
  // untimed events (after the last frame) sort last
  const key = (e: LogEvent) => (Number.isFinite(e.time) ? e.time : Infinity);
  events.sort((a, b) => key(a) - key(b));
  return { index, fieldNames, time, columns, events, sysConfig: plainSysConfig(log) };
}
