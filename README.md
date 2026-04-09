# 🔭 OpenTelemetry Lab — Node.js + Java

Laboratório para demonstrar dois cenários de observabilidade em microserviços:

| Cenário | Foco | Ferramenta principal |
|---------|------|----------------------|
| **1 — Logs estruturados** | JSON com campos de contexto | Grafana + Loki |
| **2 — Trace distribuído** | traceId propagado entre serviços | Jaeger |

## Arquitetura

```
[service-a Node.js :3000]
        │  HTTP + W3C traceparent
        ▼
[service-b Java :8080]
        │
        ▼
[OTel Collector :4317/:4318]
   ├── traces  ──► Jaeger    :16686
   ├── logs    ──► Loki      :3100
   └── metrics ──► Prometheus :9090
                        │
                   Grafana :3001
```

## Pré-requisitos

- Docker + Docker Compose v2
- (Opcional) Node.js 20+ e Java 21+ para rodar localmente

## Subindo o laboratório

```bash
docker compose up --build
```

Aguarde ~2 minutos para o service-b compilar na primeira vez.

## Cenário 1 — Logs Estruturados (JSON)

**Objetivo:** mostrar como logs em JSON com campos padronizados permitem filtrar, correlacionar e alertar no Grafana/Loki.

### Disparar

```bash
curl http://localhost:3000/scenario/logs?userId=dev123
```

### O que observar

**No terminal** — service-a emite JSON estruturado:
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Chamando service-b",
  "service": "service-a",
  "scenario": "structured-logs",
  "traceId": "abc123...",
  "step": "calling-service-b"
}
```

**No terminal** — service-b emite JSON com traceId/spanId via MDC:
```json
{
  "@timestamp": "2024-01-15T10:30:00.123Z",
  "level": "INFO",
  "message": "Processando cenário de logs estruturados",
  "service": "service-b",
  "traceId": "abc123...",
  "spanId": "def456..."
}
```

**No Grafana (Loki):** http://localhost:3001
1. Explore → Loki
2. Query: `{job="service-a"} | json | step="calling-service-b"`
3. Observe os campos estruturados disponíveis para filtro

**Diferença sem observabilidade:**
```
# Log sem estrutura — impossível filtrar por campo
INFO  Chamando service-b
```

## Cenário 2 — Trace Distribuído (traceId)

**Objetivo:** mostrar como um único traceId atravessa Node.js → Java, permitindo reconstruir o fluxo completo no Jaeger.

### Disparar

```bash
curl http://localhost:3000/scenario/trace
```

A resposta inclui o `traceId`:
```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "serviceA": "ok",
  "serviceB": { "traceId": "4bf92f3577b34da6a3ce929d0e0e4736", ... },
  "hint": "Busque este traceId no Jaeger: http://localhost:16686"
}
```

### O que observar no Jaeger

1. Acesse http://localhost:16686
2. Em **Search**, selecione `service-a` e clique em **Find Traces**
3. Abra o trace — você verá **dois spans**:
   - `GET /scenario/trace` — service-a (Node.js)
   - `GET /process` — service-b (Java)
4. Ambos compartilham o **mesmo traceId** — propagado via header `traceparent` (W3C)

**Como a propagação funciona:**
```
service-a                          service-b
   │                                   │
   │── GET /process ─────────────────► │
   │   traceparent: 00-{traceId}-...   │
   │                                   │── span filho criado
   │                                   │   com mesmo traceId
```

**Diferença sem traceId:**
- Você veria dois logs isolados sem conexão entre eles
- Impossível saber que a chamada do service-b veio do service-a

## Ferramentas da Stack

| Ferramenta | URL | Função |
|------------|-----|--------|
| Grafana | http://localhost:3001 | Dashboards, Loki (logs), Prometheus (métricas) |
| Jaeger | http://localhost:16686 | Visualização de traces distribuídos |
| Prometheus | http://localhost:9090 | Métricas e alertas |
| Loki | http://localhost:3100 | Agregação de logs JSON |
| OTel Collector | :4317 / :4318 | Pipeline central de telemetria |

## Parando o laboratório

```bash
docker compose down
```

## Estrutura do projeto

```
otel-lab/
├── service-a/          # Node.js + Express + Winston + OTel SDK
├── service-b/          # Java + Spring Boot + Micrometer Tracing
├── otel-collector/     # Configuração do OTel Collector
├── grafana/            # Datasources provisionados
├── prometheus.yml      # Scrape config
└── docker-compose.yml  # Stack completa
```
