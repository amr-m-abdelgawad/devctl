import { describe, expect, test } from "bun:test";
import { applyOtelExporterEnv, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_SERVICE_NAME, OTLP_HTTP_JSON_PROTOCOL } from "./otel-env.ts";

describe("applyOtelExporterEnv", () => {
  test("fills empty OTLP exporter fields and leaves user values alone", () => {
    const env: Record<string, string> = {};
    applyOtelExporterEnv(env, "api", "http://127.0.0.1:4318");
    expect(env[OTEL_EXPORTER_OTLP_ENDPOINT]).toBe("http://127.0.0.1:4318");
    expect(env[OTEL_EXPORTER_OTLP_PROTOCOL]).toBe(OTLP_HTTP_JSON_PROTOCOL);
    expect(env[OTEL_SERVICE_NAME]).toBe("api");
    applyOtelExporterEnv(env, "other", "http://127.0.0.1:9999");
    expect(env[OTEL_EXPORTER_OTLP_ENDPOINT]).toBe("http://127.0.0.1:4318");
    expect(env[OTEL_SERVICE_NAME]).toBe("api");
  });

  test("does nothing without an endpoint", () => {
    const env: Record<string, string> = {};
    applyOtelExporterEnv(env, "api", "");
    expect(env).toEqual({});
  });
});
