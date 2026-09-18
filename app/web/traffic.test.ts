import { describe, expect, test } from "bun:test";
import { trafficPayloadView, trafficIsError } from "./traffic.ts";

describe("web traffic helpers", () => {
  test("prefers pretty text in json mode and base64 in raw mode", () => {
    expect(trafficPayloadView({ text: "{ }", data: "YQ==" }, "json")).toBe("{ }");
    expect(trafficPayloadView({ text: "{ }", data: "YQ==" }, "raw")).toBe("YQ==");
    expect(trafficPayloadView({ omitted: true }, "json")).toContain("omitted");
  });

  test("treats grpc non-zero as error", () => {
    expect(trafficIsError({ status: 200, grpc_status: "14" })).toBe(true);
    expect(trafficIsError({ status: 200, grpc_status: "0" })).toBe(false);
  });
});
