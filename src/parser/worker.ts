// Parses blackbox files off the main thread.
import { extractLog, listLogs, openFile } from "./extract";

export type WorkerRequest = { type: "open"; bytes: ArrayBuffer } | { type: "extract"; index: number };
export type WorkerResponse =
  | { type: "logs"; logs: ReturnType<typeof listLogs> }
  | { type: "log"; log: ReturnType<typeof extractLog> }
  | { type: "error"; message: string };

let file: ReturnType<typeof openFile> | null = null;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    if (e.data.type === "open") {
      file = openFile(new Uint8Array(e.data.bytes));
      post({ type: "logs", logs: listLogs(file) });
    } else {
      if (!file) throw new Error("no file open");
      const log = extractLog(file, e.data.index);
      const buffers = [log.time.buffer, ...log.columns.map((c) => c.buffer)];
      post({ type: "log", log }, buffers);
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}
