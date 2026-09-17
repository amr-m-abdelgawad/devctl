import { describe, expect, test } from "bun:test";
import { formatHostPort, hostnameFromHostHeader, isLinkLocalOrMetadataHost, isLoopbackBindHost, isLoopbackHostname, isLoopbackPeer } from "./hosts.ts";

describe("isLinkLocalOrMetadataHost", () => {
  test("blocks link-local and metadata targets", () => {
    expect(isLinkLocalOrMetadataHost("169.254.169.254")).toBe(true);
    expect(isLinkLocalOrMetadataHost("169.254.0.1")).toBe(true);
    expect(isLinkLocalOrMetadataHost("::ffff:169.254.169.254")).toBe(true);
    expect(isLinkLocalOrMetadataHost("fe80::1")).toBe(true);
    expect(isLinkLocalOrMetadataHost("[fe80::1%eth0]")).toBe(true);
    expect(isLinkLocalOrMetadataHost("febf::abcd")).toBe(true);
    expect(isLinkLocalOrMetadataHost("metadata.google.internal")).toBe(true);
    expect(isLinkLocalOrMetadataHost("metadata")).toBe(true);
    expect(isLinkLocalOrMetadataHost("METADATA.GOOGLE.INTERNAL")).toBe(true);
  });

  test("blocks the IPv4-mapped hex form and non-link-local metadata IPs", () => {
    // new URL("http://[::ffff:169.254.169.254]/").hostname === "[::ffff:a9fe:a9fe]"
    expect(isLinkLocalOrMetadataHost("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isLinkLocalOrMetadataHost("::ffff:a9fe:a9fe")).toBe(true);
    // Alibaba Cloud metadata (outside 169.254/16).
    expect(isLinkLocalOrMetadataHost("100.100.100.200")).toBe(true);
    // A non-metadata mapped address is still allowed.
    expect(isLinkLocalOrMetadataHost("::ffff:8.8.8.8")).toBe(false);
  });

  test("allows ordinary and loopback hosts", () => {
    expect(isLinkLocalOrMetadataHost("")).toBe(false);
    expect(isLinkLocalOrMetadataHost("api.company.com")).toBe(false);
    expect(isLinkLocalOrMetadataHost("127.0.0.1")).toBe(false);
    expect(isLinkLocalOrMetadataHost("10.0.0.5")).toBe(false);
    expect(isLinkLocalOrMetadataHost("169.253.0.1")).toBe(false);
    expect(isLinkLocalOrMetadataHost("fe7f::1")).toBe(false);
    expect(isLinkLocalOrMetadataHost("metadata.example.com")).toBe(false);
  });
});

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

  test("strips a long trailing-dot suffix in linear time", () => {
    const dots = ".".repeat(10_000);
    expect(isLoopbackHostname(`localhost${dots}`)).toBe(true);
    expect(isLoopbackHostname(`evil.example${dots}`)).toBe(false);
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

describe("isLoopbackPeer", () => {
  test("allows loopback peers including IPv4-mapped", () => {
    expect(isLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects a missing or empty remote address", () => {
    expect(isLoopbackPeer(undefined)).toBe(false);
    expect(isLoopbackPeer("")).toBe(false);
    expect(isLoopbackPeer("   ")).toBe(false);
    expect(isLoopbackPeer("192.168.1.1")).toBe(false);
  });
});
