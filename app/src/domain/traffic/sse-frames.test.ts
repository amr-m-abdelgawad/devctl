import { describe, expect, test } from "bun:test";
import { isEventStreamContentType, splitSseFrames } from "./sse-frames.ts";

describe("splitSseFrames", () => {
  test("splits blank-line event boundaries into frames", () => {
    expect(splitSseFrames("data: hello\n\ndata: world\n\n")).toEqual(["data: hello", "data: world"]);
  });

  test("keeps a multi-field event as one frame", () => {
    expect(splitSseFrames("event: ping\ndata: hello\n\ndata: world\n\n")).toEqual([
      "event: ping\ndata: hello",
      "data: world",
    ]);
  });

  test("normalizes CRLF and keeps a trailing partial event", () => {
    expect(splitSseFrames("data: hello\r\n\r\ndata: wor")).toEqual(["data: hello", "data: wor"]);
  });

  test("drops empty blocks and comment-only keep-alives stay as frames", () => {
    expect(splitSseFrames("\n\n: keep-alive\n\n\n\ndata: hi\n\n")).toEqual([": keep-alive", "data: hi"]);
  });

  test("empty input is no frames", () => {
    expect(splitSseFrames("")).toEqual([]);
    expect(splitSseFrames("\n\n")).toEqual([]);
  });
});

describe("isEventStreamContentType", () => {
  test("matches prefix and charset parameter, case-insensitive", () => {
    expect(isEventStreamContentType("text/event-stream")).toBe(true);
    expect(isEventStreamContentType("text/event-stream; charset=utf-8")).toBe(true);
    expect(isEventStreamContentType("TEXT/EVENT-STREAM")).toBe(true);
    expect(isEventStreamContentType("application/json")).toBe(false);
  });
});
