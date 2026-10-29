// Emits one span and one log record every half second through the stock
// @opentelemetry/exporter-*-otlp-proto exporters, configured only from the
// OTEL_* variables devctl injects.
import { context, logs, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

// The bare providers don't read OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES
// themselves; the standard env detector does.
const resource = detectResources({ detectors: [envDetector] });
const tracerProvider = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporter() })] });
trace.setGlobalTracerProvider(tracerProvider);
// What NodeTracerProvider.register() did before 3.0: a context manager, so a
// log emitted inside an active span carries its trace id.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const loggerProvider = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: new OTLPLogExporter() })] });
logs.setGlobalLoggerProvider(loggerProvider);

const tracer = tracerProvider.getTracer("e2e");
const logger = loggerProvider.getLogger("e2e");
setInterval(() => {
  tracer.startActiveSpan("node-span", (span) => {
    logger.emit({ severityNumber: 13, severityText: "WARN", body: "hello from node exporter" });
    span.end();
  });
}, 500);
