import { describe, expect, test } from "bun:test";
import { parseUrlHost, tokenGate } from "./token-gate.ts";

describe("tokenGate", () => {
  test("attaches for a known service host:port", () => {
    expect(tokenGate({
      url: "http://127.0.0.1:4100/health",
      knownHosts: ["127.0.0.1:4100"],
      allowlist: [],
      insecureAttach: false,
    })).toBe("attach");
  });

  test("treats localhost as loopback", () => {
    expect(tokenGate({
      url: "http://localhost:4100/",
      knownHosts: ["127.0.0.1:4100"],
      allowlist: [],
      insecureAttach: false,
    })).toBe("attach");
  });

  test("skips an unknown host", () => {
    expect(tokenGate({
      url: "https://evil.example/steal",
      knownHosts: ["127.0.0.1:4100"],
      allowlist: [],
      insecureAttach: false,
    })).toBe("skip");
  });

  test("skips a known host on a different port", () => {
    expect(tokenGate({
      url: "http://127.0.0.1:9999/",
      knownHosts: ["127.0.0.1:4100"],
      allowlist: [],
      insecureAttach: false,
    })).toBe("skip");
  });

  test("attaches for an allowlisted hostname on any port", () => {
    expect(tokenGate({
      url: "https://api.internal.example:8443/v1",
      knownHosts: [],
      allowlist: ["api.internal.example"],
      insecureAttach: false,
    })).toBe("attach");
  });

  test("insecure attach bypasses the gate", () => {
    expect(tokenGate({
      url: "https://example.com",
      knownHosts: [],
      allowlist: [],
      insecureAttach: true,
    })).toBe("attach");
  });

  test("skips unparseable URLs", () => {
    expect(tokenGate({
      url: "not a url",
      knownHosts: ["127.0.0.1:80"],
      allowlist: [],
      insecureAttach: false,
    })).toBe("skip");
  });
});

describe("parseUrlHost", () => {
  test("fills default ports", () => {
    expect(parseUrlHost("https://example.com/x")).toEqual({ protocol: "https:", host: "example.com", port: "443" });
    expect(parseUrlHost("http://example.com/x")).toEqual({ protocol: "http:", host: "example.com", port: "80" });
  });
});
