'use strict';
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');

new NodeSDK({
  serviceName: 'order-service',
  traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
  logRecordProcessor: new SimpleLogRecordProcessor(
    new OTLPLogExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs` })
  ),
  instrumentations: [getNodeAutoInstrumentations()],
}).start();
