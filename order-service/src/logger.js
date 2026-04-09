'use strict';
const { createLogger, format, transports } = require('winston');
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
  defaultMeta: { service: process.env.SERVICE_NAME || 'api-gateway' },
  transports: [new transports.Console()],
});
