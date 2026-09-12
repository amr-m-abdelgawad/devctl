export const OTEL_EXPORTER_OTLP_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const OTEL_EXPORTER_OTLP_PROTOCOL = "OTEL_EXPORTER_OTLP_PROTOCOL";
export const OTEL_SERVICE_NAME = "OTEL_SERVICE_NAME";
export const OTLP_HTTP_JSON_PROTOCOL = "http/json";

export function applyOtelExporterEnv(env: Record<string, string>, serviceName: string, endpoint: string): void {
  if (endpoint.trim() === "") {
    return;
  }
  if ((env[OTEL_EXPORTER_OTLP_ENDPOINT] ?? "").trim() === "") {
    env[OTEL_EXPORTER_OTLP_ENDPOINT] = endpoint;
  }
  if ((env[OTEL_EXPORTER_OTLP_PROTOCOL] ?? "").trim() === "") {
    env[OTEL_EXPORTER_OTLP_PROTOCOL] = OTLP_HTTP_JSON_PROTOCOL;
  }
  if ((env[OTEL_SERVICE_NAME] ?? "").trim() === "") {
    env[OTEL_SERVICE_NAME] = serviceName;
  }
}
