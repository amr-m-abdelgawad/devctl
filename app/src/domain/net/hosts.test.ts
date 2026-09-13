import { describe, expect, test } from "bun:test";
import { formatHostPort, hostnameFromHostHeader, isLoopbackBindHost, isLoopbackHostname } from "./hosts.ts";

describe("isLoopbackBindHost", () => {
  test("allows loopback and empty (caller default)", () => {
    expect(isLoopbackBindHost("")).toBe(true);
    expect(isLoopbackBindHost("localhost")).toBe(true);
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("127.0.0.2")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects unspecified and non-loopback binds", () => {
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("::")).toBe(false);
    expect(isLoopbackBindHost("::0")).toBe(false);
    expect(isLoopbackBindHost("::ffff:0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("192.168.1.1")).toBe(false);
    expect(isLoopbackBindHost("*")).toBe(false);
  });
});

describe("isLoopbackHostname", () => {
  test("allows loopback names including Host-header spellings", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("localhost.")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("::1%lo0")).toBe(true);
    expect(isLoopbackHostname("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHostname("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isLoopbackHostname("127.0.0.2")).toBe(true);
  });

  test("rejects empty, unspecified, and non-loopback names", () => {
    expect(isLoopbackHostname("")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("::")).toBe(false);
    expect(isLoopbackHostname("cursor")).toBe(false);
    expect(isLoopbackHostname("host.docker.internal")).toBe(false);
    expect(isLoopbackHostname("evil.example")).toBe(false);
    expect(isLoopbackHostname("0:0:0:0:0:0:0:g")).toBe(false);
    expect(isLoopbackHostname("0:0:0:0:0:0:1:1")).toBe(false);
  });
});

describe("hostnameFromHostHeader", () => {
  test("parses IPv4, localhost, and IPv6 Host forms", () => {
    expect(hostnameFromHostHeader("127.0.0.1:18900")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("localhost:18900")).toBe("localhost");
    expect(hostnameFromHostHeader("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("localhost")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:18900")).toBe("::1");
    expect(hostnameFromHostHeader("[::1]")).toBe("::1");
    expect(hostnameFromHostHeader("::1")).toBe("::1");
    expect(hostnameFromHostHeader("::1:18900")).toBe("::1");
    expect(hostnameFromHostHeader("[::ffff:127.0.0.1]:18900")).toBe("::ffff:127.0.0.1");
    expect(hostnameFromHostHeader("::ffff:127.0.0.1:18900")).toBe("::ffff:127.0.0.1");
    expect(hostnameFromHostHeader("localhost:8080")).toBe("localhost");
    expect(hostnameFromHostHeader("[0:0:0:0:0:0:0:1]:18900")).toBe("0:0:0:0:0:0:0:1");
  });

  test("rejects empty and malformed bracketed hosts", () => {
    expect(hostnameFromHostHeader("")).toBeUndefined();
    expect(hostnameFromHostHeader("   ")).toBeUndefined();
    expect(hostnameFromHostHeader("[::1")).toBeUndefined();
    expect(hostnameFromHostHeader("[::1]18900")).toBeUndefined();
  });
});

describe("formatHostPort", () => {
  test("brackets IPv6 and leaves IPv4 unchanged", () => {
    expect(formatHostPort("127.0.0.1", 18900)).toBe("127.0.0.1:18900");
    expect(formatHostPort("::1", 18900)).toBe("[::1]:18900");
    expect(formatHostPort("[::1]", 18900)).toBe("[::1]:18900");
    expect(formatHostPort("", 80)).toBe("127.0.0.1:80");
  });
});
