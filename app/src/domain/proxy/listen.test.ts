import { describe, expect, test } from "bun:test";
import { listenKey, normalizeListenHost, sameListen } from "./listen.ts";

describe("listen bind compare", () => {
  test("empty host equals 127.0.0.1", () => {
    expect(normalizeListenHost("")).toBe("127.0.0.1");
    expect(normalizeListenHost("  ")).toBe("127.0.0.1");
    expect(normalizeListenHost(undefined)).toBe("127.0.0.1");
    expect(sameListen({ host: "", port: 8080 }, { host: "127.0.0.1", port: 8080 })).toBe(true);
  });

  test("port change is a different bind", () => {
    expect(sameListen({ host: "127.0.0.1", port: 8080 }, { host: "127.0.0.1", port: 8081 })).toBe(false);
    expect(listenKey({ host: "127.0.0.1", port: 8081 })).toBe("127.0.0.1:8081");
  });

  test("missing listen is host default and port 0", () => {
    expect(listenKey(undefined)).toBe("127.0.0.1:0");
    expect(sameListen(undefined, { host: "", port: 0 })).toBe(true);
  });

  test("equivalent IPv6 literals share a listen key", () => {
    expect(sameListen({ host: "::1", port: 8080 }, { host: "0:0:0:0:0:0:0:1", port: 8080 })).toBe(true);
    expect(sameListen({ host: "[::1]", port: 8080 }, { host: "::1", port: 8080 })).toBe(true);
    expect(sameListen({ host: "::1", port: 8080 }, { host: "::1", port: 8081 })).toBe(false);
    expect(normalizeListenHost("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
  });
});
