import { describe, expect, test } from "bun:test";
import type { Check } from "../../../domain/doctor/types.ts";
import { freeAllPrompt } from "./doctor-ports.ts";

const bun: Check = {
  name: "Port 18003",
  severity: "error",
  message: "in use by bun (pid 22356)",
  action: { kind: "free-port", holder: { port: 18003, pid: 22356, command: "bun" } },
};

describe("freeAllPrompt", () => {
  test("asks for one confirmation when several error ports can be freed", () => {
    const node: Check = {
      name: "Port 18004",
      severity: "error",
      message: "in use by node (pid 4)",
      action: { kind: "free-port", holder: { port: 18004, pid: 4, command: "node" } },
    };
    expect(freeAllPrompt([bun, node])).toEqual({
      kind: "confirm",
      detail: {
        ports: [
          { port: 18003, pid: 22356, process: "bun" },
          { port: 18004, pid: 4, process: "node" },
        ],
      },
    });
  });

  test("leaves a single error port on its own free control", () => {
    expect(freeAllPrompt([bun])).toEqual({
      kind: "status",
      status: "Click free on that port, or select it and press enter",
    });
    expect(freeAllPrompt([])).toEqual({ kind: "status", status: "No error ports to free" });
  });
});
