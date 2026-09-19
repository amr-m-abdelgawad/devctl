// Split captured `text/event-stream` bytes on blank-line event boundaries
// (WHATWG EventSource). Each frame is one event block with surrounding
// whitespace trimmed. Extra blank lines are dropped. A trailing partial
// event (truncated tee / missing final blank line) is kept as its own frame.
//
// Stored inspect text is a JSON array of these frame strings so the
// inspector shows one event per row instead of one opaque blob.

export function isEventStreamContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

export function splitSseFrames(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames: string[] = [];
  for (const block of text.split(/\n\n+/)) {
    const frame = block.trim();
    if (frame !== "") {
      frames.push(frame);
    }
  }
  return frames;
}
