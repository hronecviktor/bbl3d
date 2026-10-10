// Minimal Betaflight blackbox (.bbl) writer for synthetic sample flights.
//
// It mirrors the frame layout of a Betaflight 4.5 log (I frame every 128
// iterations, P frame every 16, GPS home/position frames, slow frames,
// events) but uses the simplest valid encodings: every field is written as
// an absolute variable-byte integer (predictor 0), except the P-frame loop
// iteration, which is implied (predictor "increment", no data).

const PRODUCT = "Blackbox flight data recorder by Nicholas Sherlock";
const PRED_ZERO = 0;
const PRED_INC = 6;
const PRED_LAST_MAIN_FRAME_TIME = 10;
const ENC_SIGNED_VB = 0;
const ENC_UNSIGNED_VB = 1;
const ENC_NULL = 9;

export const I_INTERVAL = 128; // loop iterations between I frames
export const P_INTERVAL = 16; // loop iterations between logged frames

class Bytes {
  constructor() {
    this.buf = Buffer.alloc(1 << 20);
    this.len = 0;
  }
  byte(b) {
    if (this.len === this.buf.length) {
      const next = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(next);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }
  text(s) {
    for (const ch of Buffer.from(s, "latin1")) this.byte(ch);
  }
  unsigned(v) {
    let n = Math.max(0, Math.round(v)) >>> 0;
    while (n > 127) {
      this.byte((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.byte(n);
  }
  signed(v) {
    const n = Math.round(v) | 0;
    this.unsigned(((n << 1) ^ (n >> 31)) >>> 0); // zig-zag
  }
  result() {
    return this.buf.subarray(0, this.len);
  }
}

/**
 * fields: [{ name, signed }] for main frames; gps / home / slow likewise.
 * Main fields must start with loopIteration, time.
 */
export class BlackboxWriter {
  constructor({ headers, main, gps, home, slow }) {
    this.out = new Bytes();
    this.main = main;
    this.gps = gps;
    this.home = home;
    this.slow = slow;
    const enc = (f) => (f.signed ? ENC_SIGNED_VB : ENC_UNSIGNED_VB);
    const line = (k, v) => this.out.text(`H ${k}:${v}\n`);
    line("Product", PRODUCT);
    line("Data version", "2");
    const defs = (type, list, pred, encoding) => {
      line(`Field ${type} name`, list.map((f) => f.name).join(","));
      line(`Field ${type} signed`, list.map((f) => (f.signed ? 1 : 0)).join(","));
      line(`Field ${type} predictor`, list.map(pred).join(","));
      line(`Field ${type} encoding`, list.map(encoding).join(","));
    };
    defs("I", main, () => PRED_ZERO, enc);
    line("Field P predictor", main.map((f, i) => (i === 0 ? PRED_INC : PRED_ZERO)).join(","));
    line("Field P encoding", main.map((f, i) => (i === 0 ? ENC_NULL : enc(f))).join(","));
    defs("H", home, () => PRED_ZERO, enc);
    defs("G", gps, (f) => (f.name === "time" ? PRED_LAST_MAIN_FRAME_TIME : PRED_ZERO), enc);
    defs("S", slow, () => PRED_ZERO, enc);
    line("I interval", I_INTERVAL);
    line("P interval", P_INTERVAL);
    line("P ratio", I_INTERVAL / P_INTERVAL);
    for (const [k, v] of headers) line(k, v);
  }

  /** values: array matching `main`, starting with loopIteration and time. */
  mainFrame(values) {
    const iframe = values[0] % I_INTERVAL === 0;
    this.out.byte(iframe ? 0x49 : 0x50); // 'I' / 'P'
    this.main.forEach((f, i) => {
      if (i === 0 && !iframe) return; // implied by the increment predictor
      f.signed ? this.out.signed(values[i]) : this.out.unsigned(values[i]);
    });
  }

  homeFrame(values) {
    this.out.byte(0x48); // 'H'
    this.home.forEach((f, i) => (f.signed ? this.out.signed(values[i]) : this.out.unsigned(values[i])));
  }

  /** values match `gps`; a leading "time" field is written as the offset from the last main frame. */
  gpsFrame(values) {
    this.out.byte(0x47); // 'G'
    this.gps.forEach((f, i) => (f.signed ? this.out.signed(values[i]) : this.out.unsigned(values[i])));
  }

  slowFrame(values) {
    this.out.byte(0x53); // 'S'
    this.slow.forEach((f, i) => (f.signed ? this.out.signed(values[i]) : this.out.unsigned(values[i])));
  }

  syncBeep(timeUs) {
    this.out.byte(0x45); // 'E'
    this.out.byte(0); // FLIGHT_LOG_EVENT_SYNC_BEEP
    this.out.unsigned(timeUs);
  }

  disarm(reason) {
    this.out.byte(0x45);
    this.out.byte(15); // FLIGHT_LOG_EVENT_DISARM
    this.out.unsigned(reason);
  }

  logEnd() {
    this.out.byte(0x45);
    this.out.byte(255); // FLIGHT_LOG_EVENT_LOG_END
    this.out.text("End of log");
    this.out.byte(0);
  }

  result() {
    return Buffer.from(this.out.result());
  }
}
