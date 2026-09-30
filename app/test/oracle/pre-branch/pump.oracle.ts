// Frozen from main@ed58322 app/src/adapters/process/processes.ts: the body of
// `pumpLines`, the line source every service used before this branch. Do not
// edit.
//
// main read the pipe in an async loop; this class is the same loop body run
// once per read, so the oracle can be driven chunk by chunk on a fake clock.
// Kept as main had it: a streaming TextDecoder, `\r` stripped from split lines
// and from the 1 MiB force-break but not from the leftover emitted at end of
// stream, and a decoder that is never flushed at end of stream.
//
// End of stream is the `done` read. A standalone probe of this loop against a
// real child (`printf 'first\nlast-no-newline'`, 50 runs on host bun 1.4.0 and
// in oven/bun:1.4.2) always reached `done` and emitted the unterminated last
// line, so the oracle does too.
const MAX_LINE_BYTES = 1024 * 1024;

export class PreBranchLinePump {
  private readonly decoder = new TextDecoder();
  private buf = "";

  /** One `reader.read()` that returned `value`. */
  push(value: Uint8Array): string[] {
    const out: string[] = [];
    this.buf += this.decoder.decode(value, { stream: true });
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      out.push(line.replace(/\r$/, ""));
    }
    // Force a break on a pathologically long unterminated line so `buf` cannot
    // grow without bound before a newline arrives. Shared with the long-running
    // service path, so this only affects a single >1 MiB line with no newline.
    if (Buffer.byteLength(this.buf, "utf8") >= MAX_LINE_BYTES) {
      out.push(this.buf.replace(/\r$/, ""));
      this.buf = "";
    }
    return out;
  }

  /** The `done` read. */
  end(): string[] {
    if (this.buf !== "") {
      const last = this.buf;
      this.buf = "";
      return [last];
    }
    return [];
  }
}
