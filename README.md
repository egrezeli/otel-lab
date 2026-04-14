# 🔭 OpenTelemetry Lab — Golden Signals em Microserviços

Laboratório de observabilidade com OpenTelemetry que demonstra os **4 Golden Signals de SRE**
(Latência, Tráfego, Erros e Saturação) instrumentados em todas as camadas de uma aplicação real:
API → Regra de Negócio → Banco de Dados.

A stack inclui trace distribuído, logs estruturados correlacionados por `traceId`, métricas com
percentis, alertas no Prometheus e um load-bot que gera tráfego realista com fases de carga
variadas para tornar os sinais visíveis no Grafana.

---

## Arquitetura

```
                        ┌─────────────────────────────────────────────┐
  POST /orders          │              Aplicação                       │
  ──────────────►  [api-gateway :3000]   Node.js — roteia e autentica  │
                        │  POST /orders                                │
                        ▼                                              │
                  [order-service :3001]  Node.js — orquestra o pedido  │
                        │                                              │
              ┌─────────┴──────────┐                                  │
              │ POST /reserve      │ POST /payments/charge             │
              ▼                    ▼                                   │
  [inventory-service :3002]  [payment-service :8080]                  │
   Node.js — reserva estoque  Java (Spring Boot)                      │
   PostgreSQL                 PostgreSQL                               │
                                                                       │
  [service-a :3010]  Node.js — cenários de trace e logs               │
                        └─────────────────────────────────────────────┘
                                          │
                              ┌───────────▼───────────┐
                              │   OTel Collector       │
                              │  traces / logs / métricas
                              └───┬───────┬───────┬───┘
                                  │       │       │
                              Jaeger   Loki  Prometheus
                                  └───────┴───────┘
                                          │
                                       Grafana
```

### Fluxo de uma transação

```
api-gateway → order-service → inventory-service (reserva estoque)
                            → payment-service   (cobra pagamento)
                            ← rollback de estoque se pagamento falhar
```

O mesmo `traceId` W3C atravessa todos os serviços. Cada camada emite spans, logs e métricas
para o OTel Collector, que distribui para Jaeger (traces), Loki (logs) e Prometheus (métricas).

---

## Portas

| Serviço            | Porta  | Descrição                              |
|--------------------|--------|----------------------------------------|
| api-gateway        | 3000   | Entrada pública da aplicação           |
| service-a          | 3010   | Cenários de trace e logs               |
| order-service      | 3011   | Orquestrador de pedidos                |
| inventory-service  | 3012   | Reserva de estoque                     |
| payment-service    | 8080   | Processamento de pagamento (Java)      |
| Jaeger UI          | 16686  | Visualização de traces distribuídos    |
| Grafana            | 3030   | Dashboard Golden Signals + Logs        |
| Prometheus         | 9090   | Métricas + Alertas                     |
| Loki               | 3100   | Armazenamento de logs                  |
| OTel Collector     | 4317/4318 | Recebe telemetria (gRPC/HTTP)       |

---

## Pré-requisitos

- Docker e Docker Compose v2+
- ~4 GB de RAM disponível (o payment-service Java consome mais)
- Portas listadas acima livres

---

## Subindo o laboratório

### 1. Configure as variáveis de ambiente

```bash
cp .env.example .env
# edite .env se quiser trocar as credenciais do banco
```

### 2. Suba a stack

```bash
docker compose up --build
```

Na primeira execução o Maven vai baixar as dependências do Java (~2-3 min). As seguintes são rápidas.

### 3. Verifique que tudo está saudável

```bash
docker compose ps
```

Todos os serviços devem aparecer com `STATUS: healthy` ou `running`. O load-bot começa a gerar
tráfego automaticamente assim que o `api-gateway` responder.

### 4. Acesse o Grafana

Abra http://localhost:3030 — o dashboard **OTel Lab — Golden Signals** já está provisionado e
populado com dados do load-bot.

---

## Guia de exploração

### 🚦 Passo 1 — Entenda o tráfego no Grafana

Acesse http://localhost:3030/d/otellab-golden-signals

A seção **Tráfego** mostra:
- Requisições por segundo por serviço — você verá a curva do load-bot (warm-up → normal → peak → stress → spike → cool-down)
- Distribuição por status code — 201 (sucesso), 409 (estoque insuficiente), 5xx (erros internos)

O load-bot usa pesos para simular tráfego realista:
| Produto   | Peso | Comportamento esperado         |
|-----------|------|-------------------------------|
| PROD-001  | 60%  | Sucesso (estoque = 50)         |
| PROD-002  | 25%  | Sucesso até esgotar (estoque = 3) |
| PROD-003  | 15%  | Erro 409 intencional (estoque = 0) |

---

### ⏱ Passo 2 — Observe a latência por camada

Na seção **Latência** do dashboard:

- **p50/p95/p99 do api-gateway** — latência percebida pelo usuário final
- **p99 por serviço** — identifica qual camada está mais lenta
- **Latência de DB** — operações SELECT/INSERT/UPDATE separadas por tipo

Durante a fase `stress` do load-bot (10-14 rps), observe o p99 subir. Isso é o comportamento
esperado sob pressão — o objetivo é ver o sinal, não evitá-lo.

---

### 🔴 Passo 3 — Acompanhe os alertas no Prometheus

Acesse http://localhost:9090/alerts

Os alertas definidos cobrem os 4 golden signals:

| Alerta                    | Threshold  | Severidade |
|---------------------------|------------|------------|
| TrafficDrop               | < 0.1 rps  | warning    |
| HighLatencyP99Warning     | > 500ms    | warning    |
| HighLatencyP99Critical    | > 1s       | critical   |
| HighErrorRateWarning      | > 5%       | warning    |
| HighErrorRateCritical     | > 15%      | critical   |
| DBPoolSaturationWarning   | > 6 conns  | warning    |
| DBPoolSaturationCritical  | > 9 conns  | critical   |
| DBPoolQueueBuilding       | > 0 fila   | warning    |

Durante a fase `spike` (15-20 rps), alguns alertas vão para estado `FIRING` — isso é intencional
para demonstrar o comportamento dos sinais sob carga extrema.

---

### 🔍 Passo 4 — Trace distribuído no Jaeger

#### Faça um pedido manualmente

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-42","productId":"PROD-001","quantity":2}'
```

Resposta:
```json
{
  "orderId": "ORD-1234567890",
  "traceId": "e573d718a5fa4c3acf2eef1f1c179eed",
  "inventory": { "reservationId": "RES-...", "totalPrice": 199.80 },
  "payment":   { "transactionId": "cb253aac...", "status": "approved" }
}
```

#### Visualize no Jaeger

1. Acesse http://localhost:16686
2. **Service**: `api-gateway` → **Find Traces**
3. Abra o trace — você verá a árvore completa de spans:

```
api-gateway          POST /orders                       ~150ms
  ├── auth.validate                                      ~20ms
  └── order-service  POST /orders
        ├── db: SELECT products                          ~10ms
        ├── db: INSERT orders                            ~15ms
        ├── inventory-service  POST /reserve
        │     ├── db: SELECT products FOR UPDATE         ~12ms
        │     ├── db: UPDATE products                    ~10ms
        │     └── db: INSERT inventory_reservations      ~8ms
        └── payment-service  POST /payments/charge
              ├── card.validate                          ~25ms
              └── db: INSERT payment_transactions        ~12ms
```

O mesmo `traceId` aparece em todos os 4 serviços — propagado automaticamente via W3C `traceparent`.

#### Simule uma falha de estoque

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-99","productId":"PROD-003","quantity":1}'
```

No Jaeger, o span `inventory-service POST /reserve` aparece com status **ERROR** e o atributo
`inventory.available=0`. O trace mostra exatamente onde a transação falhou, sem precisar
correlacionar logs manualmente.

---

### 📋 Passo 5 — Correlacione logs pelo traceId no Loki

1. Copie o `traceId` da resposta de um pedido
2. Acesse http://localhost:3030/explore
3. Selecione **Loki** como datasource
4. Execute a query:

```logql
{job=~"api-gateway|order-service|inventory-service|payment-service"} | json | traceId=`<cole o traceId aqui>`
```

Você verá todos os logs daquela transação, de todos os 4 serviços, ordenados por tempo — cada
linha com seu `step` indicando exatamente o que estava acontecendo.

#### Outras queries úteis

Ver apenas erros em todos os serviços:
```logql
{job=~"api-gateway|order-service|inventory-service"} | json | level=`error`
```

Acompanhar o fluxo de um pedido específico:
```logql
{job=~".+"} | json | orderId=`ORD-1234567890`
```

Ver logs de rollback de estoque (quando pagamento falha):
```logql
{job="order-service"} | json | attributes_step=`inventory-rollback`
```

Proporção de erros por serviço (métrica derivada de logs):
```logql
sum by (job) (rate({job=~"api-gateway|order-service|inventory-service"} | json | level=`error` [1m]))
```

---

### 📊 Passo 6 — Saturação: pool de conexões e requisições em voo

Na seção **Saturação** do dashboard:

- **`http_inflight_requests`** — requisições simultâneas em processamento em cada serviço.
  Presente em todos os serviços, incluindo o `api-gateway` que não tem banco.
- **Pool de conexões PostgreSQL** — conexões ativas, ociosas e em fila por serviço.
  Durante a fase `stress`, observe o pool do `order-service` e `inventory-service` se aproximar do limite.

No Prometheus, você pode explorar diretamente:

```promql
# Requisições em voo por serviço
http_inflight_requests

# Pool de conexões ativas
db_pool_connections_active

# Latência de queries SQL por tipo
histogram_quantile(0.99,
  sum by (le, db_operation_name) (
    rate(db_client_operation_duration_seconds_bucket[2m])
  )
) * 1000
```

---

### 🧪 Passo 7 — Cenários do service-a (trace e logs isolados)

O `service-a` expõe cenários didáticos para explorar trace e logs sem o ruído do fluxo principal:

```bash
# Cenário de logs estruturados com contexto de trace
curl http://localhost:3010/scenario/logs?userId=user-test

# Cenário de trace distribuído service-a → payment-service
curl http://localhost:3010/scenario/trace
```

O segundo endpoint retorna o `traceId` e um hint para buscá-lo no Jaeger. É útil para ver
um trace mais simples (2 serviços) antes de explorar o fluxo completo de 4 serviços.

---

### 🗄️ Passo 8 — Inspecione o banco de dados

```bash
docker compose exec postgres psql -U otellab -d ordersdb
```

Queries úteis:

```sql
-- Ver pedidos com seus trace IDs
SELECT id, user_id, product_id, status, trace_id, created_at
FROM orders
ORDER BY created_at DESC
LIMIT 10;

-- Estoque atual dos produtos
SELECT id, name, stock FROM products;

-- Transações de pagamento
SELECT id, order_id, amount, status, trace_id
FROM payment_transactions
ORDER BY created_at DESC
LIMIT 10;

-- Reservas de estoque
SELECT id, order_id, product_id, quantity
FROM inventory_reservations
ORDER BY created_at DESC
LIMIT 10;
```

O campo `trace_id` em todas as tabelas permite correlacionar um registro no banco com o trace
completo no Jaeger — rastreabilidade de ponta a ponta, do HTTP até o SQL.

---

## O que este lab demonstra

### Os 4 Golden Signals instrumentados em todas as camadas

| Signal     | Métrica                        | Onde                              |
|------------|-------------------------------|-----------------------------------|
| Tráfego    | `http_requests_total`          | Todos os serviços                 |
| Latência   | `http_request_duration_ms`     | Todos os serviços (p50/p95/p99)   |
| Erros      | `http_errors_total`            | Todos os serviços (4xx/5xx)       |
| Saturação  | `http_inflight_requests`       | Todos os serviços                 |
| Saturação  | `db_pool_connections_*`        | order-service, inventory-service  |
| Saturação  | `http_active_requests` (gauge) | payment-service (Java/Micrometer) |

### Observabilidade em profundidade

- **Traces**: árvore de spans com latência de cada etapa, propagação W3C automática
- **Logs**: JSON estruturado com `traceId`/`spanId` injetados, enviados via OTLP para o Loki
- **Métricas**: histogramas com percentis, contadores e gauges via OTLP para o Prometheus
- **Alertas**: regras cobrindo todos os golden signals com thresholds de warning e critical
- **Consistência**: rollback de estoque quando pagamento falha, com log de auditoria

### Pipeline OTel unificado

Todos os serviços (Node.js e Java) exportam traces, logs e métricas pelo mesmo caminho:
`serviço → OTel Collector → backends`. Não há scrape direto nem caminhos alternativos.

---

## Estrutura do projeto

```
otel-lab/
├── api-gateway/              Node.js — entrada pública, autenticação
│   └── src/
│       ├── server.js         Rotas e spans manuais
│       ├── golden-signals.js Middleware com os 4 golden signals
│       ├── instrumentation.js SDK OTel (traces + logs + métricas)
│       └── logger.js         Winston com injeção de traceId
├── order-service/            Node.js — orquestrador de pedidos
├── inventory-service/        Node.js — reserva de estoque + rollback
├── service-a/                Node.js — cenários didáticos de trace/logs
├── service-b/                Java (Spring Boot) — payment-service
│   └── src/main/
│       ├── java/.../ProcessController.java   Golden signals via Micrometer
│       └── resources/
│           ├── application.yml               Config OTel + Actuator
│           └── logback-spring.xml            JSON + OTel appender → Loki
├── load-bot/                 Gerador de tráfego com fases de carga
│   └── bot.js                warm-up → normal → peak → stress → spike → cool-down
├── otel-collector/
│   └── config.yaml           memory_limiter + batch → Jaeger/Loki/Prometheus
├── grafana/provisioning/     Datasources e dashboard provisionados
├── postgres/init.sql         Schema + dados iniciais (produtos com estoque)
├── prometheus.yml            Scrape config + evaluation_interval
├── prometheus-rules.yml      Regras de alerta dos golden signals
├── docker-compose.yml        Stack completa com healthchecks
└── .env.example              Template de variáveis de ambiente
```

---

## Parando o laboratório

```bash
# Para e remove os containers (mantém os volumes)
docker compose down

# Para, remove containers e apaga os dados do banco
docker compose down -v
```

---

## Referências

- [OpenTelemetry — Getting Started](https://opentelemetry.io/docs/getting-started/)
- [Google SRE Book — The Four Golden Signals](https://sre.google/sre-book/monitoring-distributed-systems/#xref_monitoring_golden-signals)
- [OTel Collector — memory_limiter processor](https://github.com/open-telemetry/opentelemetry-collector/tree/main/processor/memorylimiterprocessor)
- [Micrometer — Spring Boot Observability](https://micrometer.io/docs/tracing)
