import { afterEach, expect, test } from "bun:test";
import { installAnimationFrames } from "./animation-frame.ts";

const host = globalThis as typeof globalThis & {
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

const previousRequest = host.requestAnimationFrame;
const previousCancel = host.cancelAnimationFrame;

afterEach(() => {
  host.requestAnimationFrame = previousRequest;
  host.cancelAnimationFrame = previousCancel;
});

test("installAnimationFrames delegates to the renderer", () => {
  const calls: string[] = [];
  installAnimationFrames({
    requestAnimationFrame: (callback) => {
      calls.push("raf");
      callback(0);
      return 7;
    },
    cancelAnimationFrame: (handle) => {
      calls.push(`cancel:${handle}`);
    },
  });
  const id = requestAnimationFrame(() => {
    calls.push("ran");
  });
  expect(id).toBe(7);
  cancelAnimationFrame(id);
  expect(calls).toEqual(["raf", "ran", "cancel:7"]);
});
