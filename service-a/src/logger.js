'use strict';

const { createLogger, format, transports } = require('winston');
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  defaultMeta: { service: 'service-a' },
  transports: [
    new transports.Console(),
    new OpenTelemetryTransportV3(),
  ],
});

module.exports = logger;
