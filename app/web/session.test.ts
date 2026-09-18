import { describe, expect, test } from "bun:test";
import {
  WEB_CONTROL_TOKEN_KEY,
  captureControlToken,
  controlAuthHeaders,
  forgetControlToken,
  takeTokenFromHash,
} from "./session.ts";

describe("takeTokenFromHash", () => {
  test("pulls the token and strips it from the fragment", () => {
    expect(takeTokenFromHash("#token=abc")).toEqual({ token: "abc", nextHash: "" });
    expect(takeTokenFromHash("token=abc")).toEqual({ token: "abc", nextHash: "" });
  });

  test("leaves a routing fragment alone when no token is present", () => {
    expect(takeTokenFromHash("#/services")).toEqual({ token: "", nextHash: "#/services" });
    expect(takeTokenFromHash("")).toEqual({ token: "", nextHash: "" });
    expect(takeTokenFromHash("#token=")).toEqual({ token: "", nextHash: "#token=" });
  });
});

function installWindow(hash: string): Map<string, string> {
  const store = new Map<string, string>();
  const loc = { hash, pathname: "/", search: "" };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: loc,
      history: {
        replaceState(_state: unknown, _title: string, url: string) {
          const parsed = new URL(url, "http://127.0.0.1");
          loc.hash = parsed.hash;
          loc.pathname = parsed.pathname;
          loc.search = parsed.search;
        },
      },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    },
  });
  return store;
}

describe("captureControlToken", () => {
  test("stores the fragment token in localStorage so a later visit still authorizes", () => {
    const store = installWindow("#token=saved-token");
    captureControlToken();
    expect(store.get(WEB_CONTROL_TOKEN_KEY)).toBe("saved-token");
    expect(window.location.hash).toBe("");
    expect(controlAuthHeaders()).toEqual({ Authorization: "Bearer saved-token" });
    forgetControlToken();
    expect(controlAuthHeaders()).toEqual({});
  });

  test("keeps the token in memory when localStorage refuses to persist", () => {
    installWindow("#token=ephemeral");
    window.localStorage.setItem = () => {
      throw new Error("quota");
    };
    captureControlToken();
    expect(controlAuthHeaders()).toEqual({ Authorization: "Bearer ephemeral" });
    expect(window.location.hash).toBe("");
  });
});
