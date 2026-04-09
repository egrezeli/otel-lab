# 🔭 OpenTelemetry Lab — Trace Distribuído em Microserviços

Laboratório para demonstrar observabilidade em profundidade: um único `traceId` atravessa
4 serviços encadeados (Node.js + Java), tornando toda a transação rastreável no Jaeger e nos logs do Loki.

## Arquitetura

```
POST /orders
     │
     ▼
[api-gateway :3000]          Node.js — autentica e roteia
     │  POST /orders
     ▼
[order-service :3001]        Node.js — orquestra o pedido
     ├── POST /reserve
     │       ▼
     │   [inventory-service :3002]   Node.js — reserva estoque (simula DB)
     │
     └── POST /payments/charge
             ▼
         [payment-service :8080]     Java (Spring Boot) — processa cobrança

Mesmo traceId em todos os 4 serviços ──► Jaeger :16686
Logs JSON estruturados de todos        ──► Loki via Grafana :3030
```

## Portas

| Serviço            | Porta  | Descrição                        |
|--------------------|--------|----------------------------------|
| api-gateway        | 3000   | Entrada pública                  |
| order-service      | 3011   | Orquestrador de pedidos          |
| inventory-service  | 3012   | Reserva de estoque               |
| payment-service    | 8080   | Processamento de pagamento       |
| Jaeger UI          | 16686  | Visualização de traces           |
| Grafana            | 3030   | Logs (Loki) + Métricas           |
| Prometheus         | 9090   | Métricas                         |

## Subindo o laboratório

```bash
docker compose up --build
```

Aguarde ~2 minutos para o payment-service (Java) compilar na primeira vez.

---

## Cenário 1 — Pedido com sucesso

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
  "inventory": { "reservationId": "RES-...", "totalPrice": 199.8 },
  "payment":   { "transactionId": "cb253aac...", "status": "approved", "traceId": "e573d718..." }
}
```

O `traceId` é o mesmo na raiz e dentro do `payment` — propagado via W3C `traceparent`.

### Ver no Jaeger

1. Acesse http://localhost:16686
2. Service: `api-gateway` → **Find Traces**
3. Abra o trace — você verá a árvore completa de spans:

```
api-gateway          GET /orders                        ~120ms
  ├── auth.validate                                      ~20ms
  └── order-service  POST /orders
        ├── inventory.reserve
        │     ├── db.inventory.query                     ~30ms
        │     └── db.inventory.update                    ~20ms
        └── payment.charge
              ├── card.validate                          ~25ms
              └── db.payment.insert                      ~15ms
```

Todos os spans compartilham o **mesmo traceId**. Sem isso, cada serviço seria um log isolado sem conexão.

---

## Cenário 2 — Falha por estoque insuficiente

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-99","productId":"PROD-003","quantity":1}'
```

O trace mostra exatamente **onde** a transação falhou: no span `db.inventory.query` do `inventory-service`, com status ERROR.

Produtos disponíveis para teste:
| productId  | Estoque | Preço   |
|------------|---------|---------|
| PROD-001   | 50      | R$99,90 |
| PROD-002   | 3       | R$249,90|
| PROD-003   | 0       | R$19,90 |

---

## Cenário 3 — Correlacionar logs pelo traceId no Grafana/Loki

1. Faça um pedido e copie o `traceId` da resposta
2. Acesse http://localhost:3030/explore (Loki como datasource padrão)
3. Query para ver todos os logs daquela transação em todos os serviços:

```logql
{job=~"api-gateway|order-service|inventory-service|payment-service"} | json | traceid=`<traceId aqui>`
```

Você verá a sequência completa de logs de todos os 4 serviços, ordenados por tempo, com o mesmo `traceId`.

### Filtrar por step específico

```logql
{job="inventory-service"} | json | attributes_step=`stock-check`
```

### Ver apenas erros

```logql
{job=~".+"} | json | level=`error`
```

---

## O que este lab demonstra

**Sem traceId:**
- 4 serviços, 4 arquivos de log separados
- Impossível saber que o log do payment-service veio do mesmo request que o erro no inventory-service
- Debugging requer correlação manual por timestamp

**Com traceId propagado:**
- Um único ID conecta todos os logs e spans
- Jaeger mostra a árvore de spans com latência de cada etapa
- Loki permite filtrar todos os logs de uma transação com uma query
- Falhas são localizadas exatamente no serviço e span onde ocorreram

## Estrutura do projeto

```
otel-lab/
├── api-gateway/         Node.js — entrada pública, autenticação
├── order-service/       Node.js — orquestrador de pedidos
├── inventory-service/   Node.js — reserva de estoque com spans de DB
├── service-b/           Java (Spring Boot) — payment-service
├── otel-collector/      Pipeline central de telemetria
├── grafana/             Datasources provisionados
├── prometheus.yml       Scrape config
└── docker-compose.yml   Stack completa
```

## Parando o laboratório

```bash
docker compose down
```
