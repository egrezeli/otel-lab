'use strict';
const { createLogger, format, transports } = require('winston');
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');
const { trace } = require('@opentelemetry/api');

const injectTrace = format((info) => {
  const span = trace.getActiveSpan();
  if (span) {
    const ctx = span.spanContext();
    info.traceId = ctx.traceId;
    info.spanId  = ctx.spanId;
  }
  return info;
});

module.exports = createLogger({
  level: 'info',
  format: format.combine(injectTrace(), format.timestamp(), format.json()),
  defaultMeta: { service: process.env.SERVICE_NAME || 'unknown' },
  transports: [
    new transports.Console(),
    new OpenTelemetryTransportV3(),
  ],
});
