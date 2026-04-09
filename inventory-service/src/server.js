'use strict';
const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger  = require('./logger');

const app    = express();
const tracer = trace.getTracer('inventory-service');
app.use(express.json());

// Estoque simulado
const stock = { 'PROD-001': 50, 'PROD-002': 3, 'PROD-003': 0 };
const prices = { 'PROD-001': 99.90, 'PROD-002': 249.90, 'PROD-003': 19.90 };

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'inventory-service' }));

app.post('/reserve', async (req, res) => {
  const { productId, quantity, orderId } = req.body;
  const span = trace.getActiveSpan();

  span?.setAttribute('inventory.productId', productId);
  span?.setAttribute('inventory.quantity', quantity);

  // Span filho: consulta ao banco de estoque
  const available = await tracer.startActiveSpan('db.inventory.query', async (dbSpan) => {
    dbSpan.setAttribute('db.system', 'postgresql');
    dbSpan.setAttribute('db.statement', `SELECT stock FROM inventory WHERE product_id = '${productId}'`);
    await new Promise(r => setTimeout(r, 30)); // simula query
    const qty = stock[productId] ?? 0;
    dbSpan.setAttribute('db.rows_returned', 1);
    dbSpan.end();
    return qty;
  });

  logger.info('Estoque consultado', { orderId, productId, available, requested: quantity, step: 'stock-check' });

  if (available < quantity) {
    span?.setStatus({ code: SpanStatusCode.ERROR, message: 'Estoque insuficiente' });
    logger.error('Estoque insuficiente', { orderId, productId, available, requested: quantity, step: 'stock-insufficient' });
    return res.status(409).json({ error: 'Estoque insuficiente', available, requested: quantity });
  }

  // Span filho: atualização do estoque
  const reservationId = await tracer.startActiveSpan('db.inventory.update', async (dbSpan) => {
    dbSpan.setAttribute('db.system', 'postgresql');
    dbSpan.setAttribute('db.statement', `UPDATE inventory SET stock = stock - ${quantity} WHERE product_id = '${productId}'`);
    await new Promise(r => setTimeout(r, 20));
    stock[productId] -= quantity;
    const resId = `RES-${Date.now()}`;
    dbSpan.setAttribute('inventory.reservationId', resId);
    dbSpan.end();
    return resId;
  });

  const totalPrice = (prices[productId] ?? 0) * quantity;
  logger.info('Estoque reservado', { orderId, productId, reservationId, totalPrice, step: 'stock-reserved' });

  res.json({ reservationId, productId, quantity, totalPrice });
});

app.listen(3002, () => logger.info('inventory-service ouvindo na porta 3002'));
