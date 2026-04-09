'use strict';
const express = require('express');
const axios   = require('axios');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger  = require('./logger');

const app    = express();
const tracer = trace.getTracer('api-gateway');
app.use(express.json());

const ORDER_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3001';

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'api-gateway' }));

// Entrada pública: POST /orders
app.post('/orders', async (req, res) => {
  const { userId, productId, quantity = 1 } = req.body;

  if (!userId || !productId) {
    return res.status(400).json({ error: 'userId e productId são obrigatórios' });
  }

  const span = trace.getActiveSpan();
  span?.setAttribute('user.id', userId);
  span?.setAttribute('http.route', '/orders');

  // Span filho: autenticação simulada
  await tracer.startActiveSpan('auth.validate', async (authSpan) => {
    logger.info('Validando token do usuário', { userId, step: 'auth-validate' });
    await new Promise(r => setTimeout(r, 20)); // simula latência de auth
    authSpan.setAttribute('auth.userId', userId);
    authSpan.end();
  });

  logger.info('Request autenticado, roteando para order-service', {
    userId, productId, quantity, step: 'routing',
  });

  try {
    const response = await axios.post(`${ORDER_URL}/orders`, { userId, productId, quantity });
    logger.info('Pedido criado com sucesso', {
      orderId: response.data.orderId,
      traceId: span?.spanContext().traceId,
      step: 'order-created',
    });
    res.status(201).json(response.data);
  } catch (err) {
    span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logger.error('Falha ao criar pedido', { error: err.message, step: 'order-failed' });
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.listen(3000, () => logger.info('api-gateway ouvindo na porta 3000'));
