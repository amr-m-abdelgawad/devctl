import { describe, expect, test } from "bun:test";
import { holdStderrForTui, isGcpMetadataWarning, silenceGcpMetadataWarnings } from "./warnings.ts";

describe("gcp metadata warnings", () => {
  test("recognizes the lookup warning gcp-metadata emits off GCE", () => {
    expect(isGcpMetadataWarning("received unexpected error =  code = UNKNOWN", "MetadataLookupWarning")).toBe(true);
    expect(isGcpMetadataWarning("(node:1) MetadataLookupWarning: received unexpected error = x")).toBe(true);
    expect(isGcpMetadataWarning("config validate failed", "Error")).toBe(false);
  });

  test("silence drops MetadataLookupWarning and keeps other warnings", async () => {
    silenceGcpMetadataWarnings();
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
      written.push(String(chunk));
      const done = typeof enc === "function" ? enc : typeof cb === "function" ? cb : undefined;
      if (typeof done === "function") {
        done();
      }
      return true;
    }) as typeof process.stderr.write;
    process.emitWarning("received unexpected error =  code = UNKNOWN", "MetadataLookupWarning");
    process.emitWarning("keep this", "DevctlTestWarning");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    process.stderr.write = real;
    const text = written.join("");
    expect(text).not.toContain("MetadataLookupWarning");
    expect(text).not.toContain("received unexpected error");
    expect(text).toContain("DevctlTestWarning");
  });

  test("tui stderr hold drops metadata lines", () => {
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
      written.push(String(chunk));
      const done = typeof enc === "function" ? enc : typeof cb === "function" ? cb : undefined;
      if (typeof done === "function") {
        done();
      }
      return true;
    }) as typeof process.stderr.write;
    const restore = holdStderrForTui();
    process.stderr.write("(node:1) MetadataLookupWarning: received unexpected error =  code = UNKNOWN\n");
    process.stderr.write("ok line\n");
    restore();
    process.stderr.write = real;
    expect(written.some((line) => line.includes("ok line"))).toBe(true);
    expect(written.some((line) => line.includes("MetadataLookupWarning"))).toBe(false);
  });
});
