'use strict';

const express = require('express');
const axios = require('axios');
const { trace, context } = require('@opentelemetry/api');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_B_URL = process.env.SERVICE_B_URL || 'http://service-b:8080';

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'service-a' }));

// Cenário 1: Logs estruturados com contexto de observabilidade
app.get('/scenario/logs', async (req, res) => {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;

  logger.info('Iniciando cenário de logs estruturados', {
    scenario: 'structured-logs',
    traceId,
    userId: req.query.userId || 'anonymous',
    step: 'start',
  });

  try {
    logger.info('Chamando service-b', { step: 'calling-service-b', traceId });
    const response = await axios.get(`${SERVICE_B_URL}/process`, {
      params: { scenario: 'logs' },
    });

    logger.info('Resposta recebida do service-b', {
      step: 'response-received',
      traceId,
      statusCode: response.status,
      data: response.data,
    });

    res.json({ traceId, serviceA: 'ok', serviceB: response.data });
  } catch (err) {
    logger.error('Erro ao chamar service-b', { traceId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Cenário 2: TraceId propagado entre serviços (W3C traceparent)
app.get('/scenario/trace', async (req, res) => {
  const span = trace.getActiveSpan();
  const spanCtx = span?.spanContext();

  logger.info('Iniciando cenário de trace distribuído', {
    scenario: 'distributed-trace',
    traceId: spanCtx?.traceId,
    spanId: spanCtx?.spanId,
  });

  const response = await axios.get(`${SERVICE_B_URL}/process`, {
    params: { scenario: 'trace' },
  });

  res.json({
    traceId: spanCtx?.traceId,
    spanId: spanCtx?.spanId,
    serviceA: 'ok',
    serviceB: response.data,
    hint: 'Busque este traceId no Jaeger: http://localhost:16686',
  });
});

app.listen(PORT, () => logger.info(`service-a rodando na porta ${PORT}`));
