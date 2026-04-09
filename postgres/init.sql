CREATE TABLE products (
  id         VARCHAR(20) PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  price      NUMERIC(10,2) NOT NULL,
  stock      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id            VARCHAR(30) PRIMARY KEY,
  user_id       VARCHAR(50) NOT NULL,
  product_id    VARCHAR(20) REFERENCES products(id),
  quantity      INTEGER NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  trace_id      VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_reservations (
  id          VARCHAR(30) PRIMARY KEY,
  order_id    VARCHAR(30) REFERENCES orders(id),
  product_id  VARCHAR(20) REFERENCES products(id),
  quantity    INTEGER NOT NULL,
  trace_id    VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payment_transactions (
  id             VARCHAR(20) PRIMARY KEY,
  order_id       VARCHAR(30) REFERENCES orders(id),
  user_id        VARCHAR(50) NOT NULL,
  amount         NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'approved',
  trace_id       VARCHAR(64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO products (id, name, price, stock) VALUES
  ('PROD-001', 'Teclado Mecânico',  99.90, 50),
  ('PROD-002', 'Monitor 4K',       249.90,  3),
  ('PROD-003', 'Mouse Gamer',       19.90,  0);
