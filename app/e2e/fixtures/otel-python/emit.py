# Emits one span and one log record per second through the stock
# opentelemetry-exporter-otlp-proto-http exporters, configured only from the
# OTEL_* variables devctl injects.
# Run with the virtualenv e2e/setup.sh creates.
import logging
import time

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
logger_provider = LoggerProvider()
logger_provider.add_log_record_processor(SimpleLogRecordProcessor(OTLPLogExporter()))
log = logging.getLogger("e2e")
log.addHandler(LoggingHandler(logger_provider=logger_provider))
log.setLevel(logging.INFO)
tracer = trace.get_tracer("e2e")

while True:
    with tracer.start_as_current_span("python-span"):
        log.warning("hello from python exporter")
    time.sleep(1)
