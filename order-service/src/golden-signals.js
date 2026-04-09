'use strict';
const { metrics } = require('@opentelemetry/api');

/**
 * Golden Signals (SRE) via OpenTelemetry Metrics
 *
 * - Latência   : histograma http_request_duration_ms  (p50/p95/p99 no Prometheus)
 * - Tráfego    : contador   http_requests_total        (req/s por rota e status)
 * - Erros      : contador   http_errors_total          (4xx e 5xx separados)
 * - Saturação  : gauge      db_pool_connections        (conexões ativas vs total)
 */
function createGoldenSignals(serviceName, pool) {
  const meter = metrics.getMeter(serviceName);

  const requestDuration = meter.createHistogram('http_request_duration_ms', {
    description: 'Latência das requisições HTTP em milissegundos',
    unit: 'ms',
  });

  const requestsTotal = meter.createCounter('http_requests_total', {
    description: 'Total de requisições HTTP recebidas',
  });

  const errorsTotal = meter.createCounter('http_errors_total', {
    description: 'Total de erros HTTP (4xx e 5xx)',
  });

  // Saturação: pool de conexões do PostgreSQL (atualizado a cada requisição)
  if (pool) {
    meter.createObservableGauge('db_pool_connections_active', {
      description: 'Conexões ativas no pool do PostgreSQL',
    }).addCallback((obs) => obs.observe(pool.totalCount - pool.idleCount, { service: serviceName }));

    meter.createObservableGauge('db_pool_connections_idle', {
      description: 'Conexões ociosas no pool do PostgreSQL',
    }).addCallback((obs) => obs.observe(pool.idleCount, { service: serviceName }));

    meter.createObservableGauge('db_pool_connections_waiting', {
      description: 'Requisições aguardando conexão no pool',
    }).addCallback((obs) => obs.observe(pool.waitingCount, { service: serviceName }));
  }

  /**
   * Middleware Express que registra os 4 Golden Signals automaticamente
   */
  function goldenSignalsMiddleware(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
      const duration   = Date.now() - start;
      const route      = req.route?.path || req.path;
      const statusCode = String(res.statusCode);
      const labels     = { service: serviceName, route, method: req.method, status_code: statusCode };

      // Latência
      requestDuration.record(duration, labels);

      // Tráfego
      requestsTotal.add(1, labels);

      // Erros (4xx = client error, 5xx = server error)
      if (res.statusCode >= 400) {
        errorsTotal.add(1, {
          ...labels,
          error_class: res.statusCode >= 500 ? '5xx' : '4xx',
        });
      }
    });
    next();
  }

  return { goldenSignalsMiddleware };
}

module.exports = { createGoldenSignals };
