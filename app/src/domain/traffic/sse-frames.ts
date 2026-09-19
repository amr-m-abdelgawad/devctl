// Split captured `text/event-stream` bytes on blank-line event boundaries
// (WHATWG EventSource). Each frame is the event block as received — trailing
// field whitespace is kept. Extra empty delimiter blocks are dropped. A
// trailing partial event (truncated tee / missing final blank line) is kept
// as its own frame.
//
// Stored inspect text is a JSON array of these frame strings so the
// inspector shows one event per row instead of one opaque blob.

const SSE_MEDIA_TYPE = "text/event-stream";
const SSE_DATA_PREFIX = "data:";

export function isEventStreamContentType(contentType: string): boolean {
  const mediaType = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return mediaType === SSE_MEDIA_TYPE;
}

export function splitSseFrames(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames: string[] = [];
  for (const block of text.split(/\n\n+/)) {
    if (block !== "") {
      frames.push(block);
    }
  }
  return frames;
}

// Join every `data:` field in one event (WHATWG: values concatenated with `\n`,
// at most one leading space stripped per field).
export function sseEventData(event: string): string {
  const parts: string[] = [];
  for (const line of event.split("\n")) {
    if (line.startsWith(SSE_DATA_PREFIX)) {
      const value = line.slice(SSE_DATA_PREFIX.length);
      parts.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return parts.join("\n");
}
