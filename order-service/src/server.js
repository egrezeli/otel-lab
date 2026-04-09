'use strict';
const express = require('express');
const axios   = require('axios');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger  = require('./logger');

const app    = express();
const tracer = trace.getTracer('order-service');
app.use(express.json());

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3002';
const PAYMENT_URL   = process.env.PAYMENT_SERVICE_URL   || 'http://payment-service:8080';

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'order-service' }));

app.post('/orders', async (req, res) => {
  const { userId, productId, quantity } = req.body;
  const orderId = `ORD-${Date.now()}`;

  const span = trace.getActiveSpan();
  span?.setAttribute('order.id', orderId);
  span?.setAttribute('order.productId', productId);
  span?.setAttribute('order.quantity', quantity);

  logger.info('Iniciando criação de pedido', { orderId, userId, productId, quantity, step: 'order-start' });

  try {
    // Passo 1: reservar estoque
    const inventory = await tracer.startActiveSpan('inventory.reserve', async (s) => {
      logger.info('Reservando estoque', { orderId, productId, quantity, step: 'inventory-reserve' });
      const r = await axios.post(`${INVENTORY_URL}/reserve`, { productId, quantity, orderId });
      s.setAttribute('inventory.reservationId', r.data.reservationId);
      s.end();
      return r.data;
    });

    // Passo 2: processar pagamento
    const payment = await tracer.startActiveSpan('payment.charge', async (s) => {
      logger.info('Processando pagamento', { orderId, userId, amount: inventory.totalPrice, step: 'payment-charge' });
      const r = await axios.post(`${PAYMENT_URL}/payments/charge`, {
        orderId, userId, amount: inventory.totalPrice,
      });
      s.setAttribute('payment.transactionId', r.data.transactionId);
      s.end();
      return r.data;
    });

    logger.info('Pedido concluído com sucesso', {
      orderId,
      reservationId: inventory.reservationId,
      transactionId: payment.transactionId,
      step: 'order-complete',
    });

    res.status(201).json({ orderId, inventory, payment, traceId: span?.spanContext().traceId });
  } catch (err) {
    span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logger.error('Falha no fluxo do pedido', { orderId, error: err.message, step: 'order-error' });
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.listen(3001, () => logger.info('order-service ouvindo na porta 3001'));
