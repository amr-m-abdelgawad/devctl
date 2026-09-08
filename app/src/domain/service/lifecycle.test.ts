import { describe, expect, test } from "bun:test";
import { canTransition, transition } from "./lifecycle.ts";
import { StateFailed, StateRunning, StateStarting, StateStopped } from "./services.ts";

describe("service lifecycle", () => {
  test("allows STOPPED → STARTING → RUNNING", () => {
    expect(canTransition(StateStopped, StateStarting)).toBe(true);
    expect(canTransition(StateStarting, StateRunning)).toBe(true);
    expect(transition(StateStopped, StateStarting)).toBe(StateStarting);
  });

  test("rejects STOPPED → HEALTHY", () => {
    expect(canTransition(StateStopped, "HEALTHY")).toBe(false);
    expect(() => transition(StateStopped, "HEALTHY")).toThrow(/illegal service lifecycle/);
  });

  test("allows RUNNING → FAILED", () => {
    expect(canTransition(StateRunning, StateFailed)).toBe(true);
  });
});
