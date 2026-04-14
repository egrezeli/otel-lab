'use strict';
const express  = require('express');
const axios    = require('axios');
const { Pool } = require('pg');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger   = require('./logger');
const { createGoldenSignals } = require('./golden-signals');

const app  = express();
const dbUrl  = new URL(process.env.DATABASE_URL.replace('postgresql://', 'http://'));
const pool   = new Pool({
  host: dbUrl.hostname, port: Number(dbUrl.port) || 5432,
  database: dbUrl.pathname.slice(1),
  user: dbUrl.username, password: dbUrl.password,
});
app.use(express.json());

const { goldenSignalsMiddleware } = createGoldenSignals('order-service', pool);
app.use(goldenSignalsMiddleware);

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3002';
const PAYMENT_URL   = process.env.PAYMENT_SERVICE_URL   || 'http://payment-service:8080';

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'order-service' }));

app.post('/orders', async (req, res) => {
  const { userId, productId, quantity } = req.body;
  const orderId = `ORD-${Date.now()}`;
  const span    = trace.getActiveSpan();
  span?.setAttribute('order.id', orderId);
  span?.setAttribute('order.productId', productId);

  logger.info('Iniciando criação de pedido', { orderId, userId, productId, quantity, step: 'order-start' });

  try {
    const traceId = span?.spanContext().traceId;
    const { rows } = await pool.query('SELECT price FROM products WHERE id = $1', [productId]);
    const totalPrice = rows.length ? parseFloat(rows[0].price) * quantity : 0;

    logger.info('Persistindo pedido no banco', { orderId, traceId, step: 'db-order-insert' });
    await pool.query(
      'INSERT INTO orders (id, user_id, product_id, quantity, total_price, status, trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orderId, userId, productId, quantity, totalPrice, 'pending', traceId]
    );

    logger.info('Reservando estoque', { orderId, productId, quantity, step: 'inventory-reserve' });
    const inventory = (await axios.post(`${INVENTORY_URL}/reserve`, { productId, quantity, orderId })).data;

    try {
      logger.info('Processando pagamento', { orderId, amount: inventory.totalPrice, step: 'payment-charge' });
      const payment = (await axios.post(`${PAYMENT_URL}/payments/charge`, {
        orderId, userId, amount: inventory.totalPrice,
      })).data;

      logger.info('Atualizando status do pedido', { orderId, step: 'db-order-update' });
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['completed', orderId]);

      logger.info('Pedido concluído', { orderId, transactionId: payment.transactionId, step: 'order-complete' });
      res.status(201).json({ orderId, inventory, payment, traceId });
    } catch (paymentErr) {
      // Pagamento falhou — reverte a reserva de estoque para manter consistência
      logger.warn('Pagamento falhou, revertendo reserva de estoque', { orderId, error: paymentErr.message, step: 'inventory-rollback' });
      await axios.post(`${INVENTORY_URL}/release`, { productId, quantity, orderId }).catch((releaseErr) => {
        logger.error('Falha ao reverter estoque — inconsistência detectada', { orderId, error: releaseErr.message, step: 'inventory-rollback-failed' });
      });
      throw paymentErr;
    }
  } catch (err) {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['failed', orderId]).catch(() => {});
    span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logger.error('Falha no fluxo do pedido', { orderId, error: err.message, step: 'order-error' });
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.listen(3001, () => logger.info('order-service ouvindo na porta 3001'));
