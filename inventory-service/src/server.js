'use strict';
const express  = require('express');
const { Pool } = require('pg');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger   = require('./logger');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'inventory-service' }));

app.post('/reserve', async (req, res) => {
  const { productId, quantity, orderId } = req.body;
  const span = trace.getActiveSpan();
  span?.setAttribute('inventory.productId', productId);
  span?.setAttribute('inventory.quantity', quantity);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // SELECT com lock — span gerado automaticamente pelo @opentelemetry/instrumentation-pg
    logger.info('Consultando estoque no banco', { orderId, productId, step: 'db-stock-select' });
    const { rows } = await client.query(
      'SELECT stock, price FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );

    if (!rows.length || rows[0].stock < quantity) {
      await client.query('ROLLBACK');
      const available = rows[0]?.stock ?? 0;
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'Estoque insuficiente' });
      logger.error('Estoque insuficiente', { orderId, productId, available, requested: quantity, step: 'stock-insufficient' });
      return res.status(409).json({ error: 'Estoque insuficiente', available, requested: quantity });
    }

    const totalPrice = parseFloat(rows[0].price) * quantity;

    // UPDATE estoque
    logger.info('Atualizando estoque no banco', { orderId, productId, quantity, step: 'db-stock-update' });
    await client.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2',
      [quantity, productId]
    );

    // INSERT reserva
    const reservationId = `RES-${Date.now()}`;
    const traceId = span?.spanContext().traceId;
    logger.info('Persistindo reserva', { orderId, reservationId, traceId, step: 'db-reservation-insert' });
    await client.query(
      'INSERT INTO inventory_reservations (id, order_id, product_id, quantity, trace_id) VALUES ($1,$2,$3,$4,$5)',
      [reservationId, orderId, productId, quantity, traceId]
    );

    await client.query('COMMIT');
    logger.info('Estoque reservado com sucesso', { orderId, reservationId, totalPrice, step: 'stock-reserved' });
    res.json({ reservationId, productId, quantity, totalPrice });
  } catch (err) {
    await client.query('ROLLBACK');
    span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logger.error('Erro ao reservar estoque', { orderId, error: err.message, step: 'db-error' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.listen(3002, () => logger.info('inventory-service ouvindo na porta 3002'));
