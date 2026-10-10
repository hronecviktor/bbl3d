// Main-thread side of the parser worker.
import type { ExtractedLog, LogSummary } from "./extract";
import type { WorkerRequest, WorkerResponse } from "./worker";

export class LogFile {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

  private request(msg: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
        e.data.type === "error" ? reject(new Error(e.data.message)) : resolve(e.data);
      this.worker.onerror = (e) => reject(new Error(e.message));
      this.worker.postMessage(msg, transfer);
    });
  }

  async open(bytes: ArrayBuffer): Promise<LogSummary[]> {
    const res = await this.request({ type: "open", bytes }, [bytes]);
    if (res.type !== "logs") throw new Error("unexpected parser reply");
    return res.logs;
  }

  async extract(index: number): Promise<ExtractedLog> {
    const res = await this.request({ type: "extract", index });
    if (res.type !== "log") throw new Error("unexpected parser reply");
    return res.log;
  }

  dispose() {
    this.worker.terminate();
  }
}
