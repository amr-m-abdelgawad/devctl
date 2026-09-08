import { describe, expect, test } from "bun:test";
import { navItemForDigit } from "../helpers/navigation.ts";
import { handleScreenDigitKey, type ScreenDigitCtx } from "./keyboard-screens.ts";

function digitCtx(overrides: Partial<ScreenDigitCtx>): ScreenDigitCtx {
  return {
    screen: "dashboard",
    logSearchFocused: false,
    logSources: [],
    logs: [],
    setLogService: () => {},
    listCursor: 0,
    setMcpPortDraft: () => {},
    ...overrides,
  };
}

describe("handleScreenDigitKey", () => {
  test("logs 1 is consumed instead of a nav jump", () => {
    let service = "";
    const consumed = handleScreenDigitKey(digitCtx({
      screen: "logs",
      logSources: ["api"],
      setLogService: (next) => {
        service = typeof next === "function" ? next(service) : next;
      },
    }), { name: "1" });
    expect(consumed).toBe(true);
    expect(service).toBe("");
    expect(navItemForDigit("1")).toBe("dashboard");
  });

  test("MCP port-row 5 is consumed", () => {
    let draft = "";
    const consumed = handleScreenDigitKey(digitCtx({
      screen: "mcp",
      listCursor: 1,
      setMcpPortDraft: (update) => {
        draft = typeof update === "function" ? update(draft) : update;
      },
    }), { name: "5" });
    expect(consumed).toBe(true);
    expect(draft).toBe("5");
  });
});
