# Guia OpenTelemetry para Desenvolvedores

Este guia explica os conceitos fundamentais do OpenTelemetry usando os arquivos reais deste
laboratório como referência. Cada seção parte do zero — sem assumir conhecimento prévio de OTel.

---

## O que é OpenTelemetry e por que ele existe

Antes do OpenTelemetry, cada ferramenta de observabilidade (Datadog, New Relic, Jaeger, Zipkin)
tinha seu próprio SDK. Se você instrumentava sua aplicação com o SDK do Datadog e depois queria
migrar para o Jaeger, precisava reescrever toda a instrumentação.

O OpenTelemetry resolve isso sendo uma **camada neutra**: você instrumenta sua aplicação uma vez
com o SDK do OTel, e os dados podem ser enviados para qualquer backend (Jaeger, Grafana, Datadog,
New Relic, etc.) sem mudar uma linha do seu código de aplicação.

```
Sua aplicação
     │
     │  SDK OTel (uma vez só)
     ▼
OTel Collector
     │
     ├──► Jaeger    (traces)
     ├──► Loki      (logs)
     └──► Prometheus (métricas)
```

O OTel padroniza três tipos de dados — chamados de **sinais**:

- **Traces** — o caminho que uma requisição percorre pelos serviços
- **Logs** — eventos textuais com contexto estruturado
- **Métricas** — valores numéricos agregados ao longo do tempo

---

## Conceito 1 — O SDK precisa ser o primeiro código a rodar

### O problema

O OpenTelemetry funciona através de uma técnica chamada **monkey-patching**: ele intercepta
bibliotecas populares (Express, axios, pg, http nativo) e adiciona instrumentação automática
nelas. Para isso funcionar, o SDK precisa se registrar **antes** que qualquer uma dessas
bibliotecas seja carregada na memória.

Se o Express for carregado antes do SDK, o OTel não consegue mais interceptá-lo — é como
tentar instalar uma câmera de segurança depois que o ladrão já entrou.

### Como está implementado no lab

**`api-gateway/Dockerfile`**
```dockerfile
CMD ["node", "--require", "./src/instrumentation.js", "src/server.js"]
```

O flag `--require` do Node.js força um arquivo a ser carregado antes de qualquer outro.
Isso garante que `instrumentation.js` roda antes do `server.js` — e portanto antes do
`require('express')` e `require('axios')` que estão no `server.js`.

**`api-gateway/src/instrumentation.js`**
```js
new NodeSDK({
  serviceName,
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  logRecordProcessor: new BatchLogRecordProcessor(
    new OTLPLogExporter({ url: `${endpoint}/v1/logs` })
  ),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 10000,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
}).start();
```

O `NodeSDK` é o ponto central de configuração. Ele recebe:
- Para onde enviar cada tipo de sinal (traces, logs, métricas)
- Quais bibliotecas instrumentar automaticamente (`getNodeAutoInstrumentations`)
- O nome do serviço — que vai aparecer no Jaeger e no Grafana

### No Java (Spring Boot)

No `service-b`, o Spring Boot 3 com Micrometer faz o equivalente via `application.yml`:

```yaml
management:
  otlp:
    tracing:
      endpoint: http://otel-collector:4318/v1/traces
    metrics:
      export:
        url: http://otel-collector:4318/v1/metrics
```

Não há um arquivo `instrumentation.js` equivalente porque o Spring Boot gerencia o ciclo de
vida dos beans automaticamente — mas o princípio é o mesmo: configurar antes de qualquer
código de negócio rodar.

### O que acontece se você errar a ordem

Se você fizer `require('./src/instrumentation')` dentro do `server.js` (em vez de usar
`--require`), o Express já foi carregado antes do SDK. Resultado: você não terá spans
automáticos de HTTP, as rotas não aparecerão no Jaeger, e vai parecer que o OTel não está
funcionando — quando na verdade o problema é só a ordem de inicialização.

---

## Conceito 2 — Auto-instrumentation vs. instrumentação manual

### O que você ganha de graça

O `getNodeAutoInstrumentations()` instrumenta automaticamente dezenas de bibliotecas.
No contexto deste lab, isso significa que **sem escrever nenhum código adicional** você já tem:

- Spans para cada requisição HTTP recebida (Express)
- Spans para cada chamada HTTP feita (axios)
- Spans para cada query SQL executada (pg/postgres)
- Propagação automática do `traceId` entre serviços via header `traceparent`

Você pode ver isso no Jaeger: os spans `db SELECT`, `db INSERT`, `HTTP POST /reserve` são
todos gerados automaticamente — nenhum deles tem código manual no lab.

### O que você precisa criar manualmente

A auto-instrumentação não sabe nada sobre a sua regra de negócio. Ela sabe que uma query
SQL foi executada, mas não sabe que aquela query era para "validar se o usuário tem crédito
suficiente" ou "verificar se o produto está em promoção".

Spans manuais são para **operações de negócio relevantes** que você quer rastrear:

**`api-gateway/src/server.js`**
```js
// Este span representa uma etapa de negócio — validação de autenticação
// O OTel não sabe que isso existe sem você criar explicitamente
await tracer.startActiveSpan('auth.validate', async (authSpan) => {
  logger.info('Validando token do usuário', { userId, step: 'auth-validate' });
  await new Promise(r => setTimeout(r, 20)); // simula chamada ao serviço de auth
  authSpan.setAttribute('auth.userId', userId);
  authSpan.end(); // IMPORTANTE: sempre feche o span
});
```

**`service-b/.../ProcessController.java`**
```java
// Span filho para validação do cartão — etapa de negócio relevante
var validateSpan = tracer.nextSpan().name("card.validate").start();
try (var ws = tracer.withSpan(validateSpan)) {
  Thread.sleep(25); // simula chamada à operadora
  validateSpan.tag("card.validated", "true");
} finally {
  validateSpan.end();
}
```

### Regra prática

Pergunte: "se esse código demorar 10 segundos, eu conseguiria ver isso no Jaeger?"

- Query SQL lenta → sim, auto-instrumentation já cobre
- Chamada HTTP lenta → sim, auto-instrumentation já cobre
- Validação de regra de negócio lenta → **não**, você precisa criar um span manual

---

## Conceito 3 — Atributos e status de spans

### Por que atributos importam

Um span sem atributos no Jaeger aparece assim:
```
POST /orders   120ms
```

Um span com atributos aparece assim:
```
POST /orders   120ms
  order.id = ORD-1717000000
  order.productId = PROD-001
  user.id = user-42
  order.quantity = 2
```

A diferença é enorme na hora de debugar. Com atributos, você consegue filtrar no Jaeger
por `order.id` e encontrar exatamente a transação que falhou, sem precisar vasculhar logs.

### Como adicionar atributos

**`order-service/src/server.js`**
```js
const span = trace.getActiveSpan(); // pega o span que está ativo no momento
span?.setAttribute('order.id', orderId);
span?.setAttribute('order.productId', productId);
```

O `?.` (optional chaining) é importante: em testes ou ambientes sem OTel configurado,
`getActiveSpan()` retorna `undefined`. O `?.` evita que seu código quebre nesses casos.

**`inventory-service/src/server.js`**
```js
span?.setAttribute('inventory.productId', productId);
span?.setAttribute('inventory.quantity', quantity);
```

### Marcando erros no span

Quando algo dá errado, você precisa marcar o span como erro explicitamente. Caso contrário,
o Jaeger vai mostrar o span como bem-sucedido mesmo que uma exceção tenha sido lançada.

```js
// Sem isso, o span aparece verde no Jaeger mesmo com erro
span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
```

No Jaeger, spans com `SpanStatusCode.ERROR` aparecem em vermelho e ficam destacados na
árvore de spans — tornando imediato identificar onde a transação falhou.

### Convenções de nomenclatura

O OTel tem convenções semânticas para atributos comuns. Seguir essas convenções permite
que ferramentas como o Grafana entendam automaticamente o significado dos atributos:

- `http.method`, `http.route`, `http.status_code` — para spans HTTP
- `db.system`, `db.operation`, `db.statement` — para spans de banco (gerados automaticamente)
- `user.id` — para identificar o usuário da requisição
- Atributos de negócio: use prefixo do domínio, ex: `order.id`, `payment.amount`

---

## Conceito 4 — Propagação de contexto entre serviços

### O problema que a propagação resolve

Imagine que o `api-gateway` recebe uma requisição e cria um span com `traceId = abc123`.
Ele então chama o `order-service`. Como o `order-service` sabe que deve criar seus spans
como filhos do span do `api-gateway`, e não como uma transação completamente nova?

A resposta é o **W3C Trace Context** — um padrão que define como passar o contexto de trace
entre serviços via headers HTTP. O header se chama `traceparent` e tem este formato:

```
traceparent: 00-abc123...(traceId)-def456...(spanId)-01
```

### Como funciona no lab

A boa notícia: **você não precisa fazer nada**. O auto-instrumentation injeta e lê o
`traceparent` automaticamente em todas as chamadas HTTP.

Quando o `api-gateway` chama o `order-service` via axios:
```js
// O OTel injeta automaticamente o header traceparent nesta chamada
const response = await axios.post(`${ORDER_URL}/orders`, { userId, productId, quantity });
```

Quando o `order-service` recebe a requisição, o Express (instrumentado pelo OTel) lê o
`traceparent` e continua o trace — todos os spans criados a partir daí são filhos do span
original do `api-gateway`.

### O que pode quebrar a propagação

O problema acontece quando você cria um cliente HTTP **fora do contexto de execução**:

```js
// ❌ Criado no startup da aplicação, fora de qualquer span
const httpClient = axios.create({ baseURL: 'http://order-service:3001' });

// Quando usado dentro de uma requisição, o contexto pode não ser propagado
// dependendo de como o axios foi instrumentado
app.post('/orders', async (req, res) => {
  await httpClient.post('/orders', body); // risco de perder o traceparent
});
```

```js
// ✅ Seguro — o axios padrão sempre usa o contexto ativo no momento da chamada
app.post('/orders', async (req, res) => {
  await axios.post(`${ORDER_URL}/orders`, body); // traceparent injetado corretamente
});
```

### Verificando no Jaeger

Para confirmar que a propagação está funcionando, faça um pedido e observe no Jaeger:
o `traceId` da resposta do `api-gateway` deve ser exatamente o mesmo que aparece nos
spans do `payment-service` Java — dois runtimes completamente diferentes compartilhando
o mesmo trace.

---

## Conceito 5 — Logs estruturados com traceId

### O problema sem correlação

Sem correlação, você tem dois mundos separados:
- No Jaeger: "o span `POST /orders` demorou 2 segundos"
- No Loki: "erro: estoque insuficiente para PROD-002"

Mas você não consegue ligar um ao outro. Qual requisição gerou aquele erro? De qual usuário?
Em qual momento exato dentro do span?

### A solução: injetar traceId nos logs

**`api-gateway/src/logger.js`**
```js
// Este formatter roda em cada log emitido
const injectTrace = format((info) => {
  const span = trace.getActiveSpan();
  if (span) {
    const ctx = span.spanContext();
    info.traceId = ctx.traceId; // mesmo ID que aparece no Jaeger
    info.spanId  = ctx.spanId;  // ID do span específico onde o log foi emitido
  }
  return info;
});
```

Com isso, cada linha de log emitida dentro de uma requisição carrega automaticamente o
`traceId`. O log JSON resultante fica assim:

```json
{
  "level": "info",
  "message": "Reservando estoque",
  "service": "order-service",
  "orderId": "ORD-1717000000",
  "traceId": "e573d718a5fa4c3acf2eef1f1c179eed",
  "spanId": "a1b2c3d4e5f6",
  "step": "inventory-reserve",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### O OpenTelemetryTransportV3

Além de injetar o `traceId`, o logger usa um transport especial que envia os logs
diretamente para o OTel Collector via OTLP:

```js
transports: [
  new transports.Console(),          // imprime no stdout (visível no docker logs)
  new OpenTelemetryTransportV3(),    // envia para o OTel Collector → Loki
],
```

Isso significa que os logs chegam ao Loki com os mesmos metadados do trace — permitindo
navegação bidirecional: do Jaeger para os logs, e dos logs para o Jaeger.

### No Java

O `logback-spring.xml` faz o equivalente com o appender OTel:

```xml
<appender name="OTEL"
  class="io.opentelemetry.instrumentation.logback.appender.v1_0.OpenTelemetryAppender">
  <captureExperimentalAttributes>true</captureExperimentalAttributes>
</appender>
```

O Micrometer Tracing injeta automaticamente `traceId` e `spanId` no MDC (Mapped Diagnostic
Context) do Logback — o mesmo mecanismo que o `injectTrace` formatter faz no Node.js.

### Explorando no Loki

Com a correlação funcionando, você consegue fazer queries poderosas:

```logql
# Todos os logs de uma transação específica, em todos os serviços
{job=~"api-gateway|order-service|inventory-service|payment-service"}
  | json
  | traceId=`e573d718a5fa4c3acf2eef1f1c179eed`
```

```logql
# Apenas os passos de erro, com contexto de qual pedido falhou
{job=~".+"} | json | level=`error` | line_format "{{.orderId}} — {{.message}}"
```

---

## Conceito 6 — Tipos de métricas e por que o histograma é obrigatório para latência

### Os quatro tipos de instrumentos

**Counter** — só aumenta, nunca diminui. Use para contar eventos.
```js
const requestsTotal = meter.createCounter('http_requests_total');
requestsTotal.add(1, { service, route, status_code });
```
Permite calcular taxa: `rate(http_requests_total[1m])` = requisições por segundo.

**UpDownCounter** — sobe e desce. Use para valores que flutuam.
```js
const inflightRequests = meter.createUpDownCounter('http_inflight_requests');
inflightRequests.add(1, labels);  // quando a requisição chega
inflightRequests.add(-1, labels); // quando a requisição termina
```

**ObservableGauge** — valor pontual observado periodicamente. Use para estado atual.
```js
meter.createObservableGauge('db_pool_connections_active')
  .addCallback((obs) => obs.observe(pool.totalCount - pool.idleCount, { service }));
```
O callback é chamado pelo SDK periodicamente para coletar o valor atual.

**Histogram** — distribui valores em buckets. **Obrigatório para latência.**
```js
const requestDuration = meter.createHistogram('http_request_duration_ms', { unit: 'ms' });
requestDuration.record(duration, labels);
```

### Por que histograma para latência?

Se você usar um Counter para somar latências, você consegue calcular a média:
`sum(latência) / count(requisições)`. Mas a média é enganosa.

Imagine 100 requisições: 99 demoram 10ms e 1 demora 10.000ms.
- Média: ~109ms — parece razoável
- p99: 10.000ms — 1% dos usuários espera 10 segundos

O histograma armazena a distribuição dos valores em buckets (ex: quantas requisições
ficaram entre 0-10ms, 10-50ms, 50-100ms, etc.). Com isso você consegue calcular percentis:

```promql
# p99 de latência — o que 99% dos usuários experimentam ou melhor
histogram_quantile(0.99,
  sum by (le) (rate(http_request_duration_ms_milliseconds_bucket[2m]))
)
```

Isso só é possível porque o tipo é `Histogram`. Com `Counter` ou `Gauge`, essa query
simplesmente não funciona.

### O erro mais comum

```js
// ❌ Errado — Counter não permite calcular percentis
const latencyCounter = meter.createCounter('request_latency_total');
latencyCounter.add(duration); // você só consegue a soma, não a distribuição

// ✅ Certo — Histogram permite p50, p95, p99
const requestDuration = meter.createHistogram('http_request_duration_ms');
requestDuration.record(duration, labels);
```

---

## Conceito 7 — Cardinalidade de labels: o risco que derruba o Prometheus

### O que é cardinalidade

Cada combinação única de labels cria uma **série temporal** separada no Prometheus.
O Prometheus armazena todas essas séries em memória. Alta cardinalidade = muitas séries
= alto consumo de memória = Prometheus lento ou crashando.

### Um exemplo concreto

```js
// Esta métrica com labels controlados cria poucas séries:
// service (4 valores) × route (3 valores) × method (2 valores) × status_code (5 valores)
// = 4 × 3 × 2 × 5 = 120 séries — completamente gerenciável
requestsTotal.add(1, { service, route, method, status_code });
```

```js
// ❌ Adicionar userId explode a cardinalidade:
// 120 séries × 10.000 usuários = 1.200.000 séries — derruba o Prometheus
requestsTotal.add(1, { service, route, method, status_code, userId });
```

### Labels que NUNCA devem ser usados em métricas

| Label problemático | Por quê                                    |
|--------------------|--------------------------------------------|
| `userId`           | Cresce com a base de usuários              |
| `orderId`          | Cada pedido é único                        |
| `traceId`          | Cada requisição tem um ID único            |
| `sessionId`        | Cada sessão é única                        |
| `email`            | Cardinalidade ilimitada + dados sensíveis  |
| `ip`               | Pode ter milhares de valores únicos        |

### Onde colocar informações de alta cardinalidade

Esses dados pertencem aos **traces e logs**, não às métricas:

```js
// ✅ traceId vai no log — não na métrica
logger.info('Pedido criado', { orderId, traceId, userId });

// ✅ traceId vai no atributo do span — não na métrica
span?.setAttribute('order.id', orderId);

// ✅ Na métrica, apenas labels de baixa cardinalidade
requestsTotal.add(1, { service, route, status_code });
```

### Como verificar no lab

O dashboard do Grafana tem um painel "Cardinalidade de métricas" que mostra quantas séries
cada métrica tem. No Prometheus, você pode verificar diretamente:

```promql
# Quantas séries a métrica http_requests_total tem?
count({__name__="http_requests_total"})

# Total de séries ativas no Prometheus
sum(scrape_samples_scraped)
```

---

## Conceito 8 — BatchLogRecordProcessor: por que o modo síncrono é perigoso

### Como o SimpleLogRecordProcessor funciona

O `SimpleLogRecordProcessor` processa cada log de forma **síncrona e bloqueante**:

```
Código emite log
      │
      ▼
SimpleLogRecordProcessor.onEmit()
      │
      ▼  ← sua aplicação está parada aqui esperando
Serializa o log
      │
      ▼
Faz chamada HTTP para o OTel Collector (rede!)
      │
      ▼  ← só depois disso o código continua
Código continua executando
```

Em Node.js, isso bloqueia o event loop. Em Java, bloqueia a thread. Em ambos os casos,
a latência da rede do OTel Collector é adicionada a **cada log emitido** — e se o
Collector estiver lento ou indisponível, sua aplicação fica lenta junto.

### Como o BatchLogRecordProcessor funciona

```
Código emite log
      │
      ▼
BatchLogRecordProcessor.onEmit()
      │
      ▼  ← retorna imediatamente, código continua
Log vai para buffer em memória
      │
      (em background, a cada N ms ou N logs)
      ▼
Serializa lote de logs
      │
      ▼
Envia para o OTel Collector (sem bloquear a aplicação)
```

### A mudança no código

**`api-gateway/src/instrumentation.js`**
```js
// ❌ Antes — síncrono, bloqueia a cada log
logRecordProcessor: new SimpleLogRecordProcessor(
  new OTLPLogExporter({ url: `${endpoint}/v1/logs` })
),

// ✅ Depois — assíncrono, não bloqueia
logRecordProcessor: new BatchLogRecordProcessor(
  new OTLPLogExporter({ url: `${endpoint}/v1/logs` })
),
```

A mudança é de uma palavra, mas o impacto em produção é significativo. O
`BatchLogRecordProcessor` também é mais eficiente na rede — em vez de uma chamada HTTP
por log, ele agrupa dezenas de logs em uma única chamada.

### Quando o SimpleLogRecordProcessor é aceitável

Apenas em desenvolvimento local, quando você quer ver os logs chegando no Loki
imediatamente sem esperar o batch. Em qualquer ambiente compartilhado ou de produção,
use sempre o `BatchLogRecordProcessor`.

---

## Resumo: checklist para instrumentar um novo serviço

Ao criar um novo serviço, percorra esta lista:

- [ ] `instrumentation.js` (ou equivalente) criado e carregado via `--require` antes de tudo
- [ ] `serviceName` configurado — aparecerá no Jaeger, Grafana e Loki
- [ ] Endpoint do OTel Collector configurado via variável de ambiente
- [ ] `BatchLogRecordProcessor` (não `Simple`) para logs
- [ ] Logger injeta `traceId` e `spanId` em cada linha de log
- [ ] Spans manuais criados para operações de negócio relevantes
- [ ] Atributos adicionados nos spans com contexto de negócio
- [ ] `span.setStatus(ERROR)` chamado nos blocos `catch`
- [ ] Métricas usando o tipo correto (Histogram para latência, Counter para eventos)
- [ ] Labels de métricas com cardinalidade controlada (sem userId, orderId, traceId)
- [ ] Endpoint `/health` implementado (para healthcheck do Docker e load balancer)

---

## Arquivos de referência neste lab

| Conceito                        | Arquivo                                      |
|---------------------------------|----------------------------------------------|
| Inicialização do SDK (Node.js)  | `api-gateway/src/instrumentation.js`         |
| Inicialização do SDK (Java)     | `service-b/src/main/resources/application.yml` |
| Spans manuais e atributos       | `api-gateway/src/server.js`                  |
| Spans manuais e atributos       | `order-service/src/server.js`                |
| Spans com erro e rollback       | `inventory-service/src/server.js`            |
| Spans manuais Java              | `service-b/.../ProcessController.java`       |
| Logger com injeção de traceId   | `api-gateway/src/logger.js`                  |
| Logger Java com OTel appender   | `service-b/src/main/resources/logback-spring.xml` |
| Golden signals (todos os tipos) | `api-gateway/src/golden-signals.js`          |
| Pipeline OTel Collector         | `otel-collector/config.yaml`                 |
| Alertas baseados em métricas    | `prometheus-rules.yml`                       |
