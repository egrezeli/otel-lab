package com.otellab.serviceb;

import io.micrometer.core.instrument.*;
import io.micrometer.tracing.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

@RestController
@RequestMapping("/payments")
public class ProcessController {

    private static final Logger log = LoggerFactory.getLogger(ProcessController.class);

    private final Tracer            tracer;
    private final PaymentRepository repository;

    // Golden Signals
    private final Counter      requestsTotal;
    private final Counter      errorsTotal;
    private final Timer        requestDuration;
    private final AtomicInteger activeRequests = new AtomicInteger(0);

    public ProcessController(Tracer tracer, PaymentRepository repository, MeterRegistry meterRegistry) {
        this.tracer     = tracer;
        this.repository = repository;

        // Tráfego
        this.requestsTotal = Counter.builder("http_requests_total")
                .tag("service", "payment-service").tag("route", "/payments/charge")
                .description("Total de requisições recebidas")
                .register(meterRegistry);

        // Erros
        this.errorsTotal = Counter.builder("http_errors_total")
                .tag("service", "payment-service").tag("route", "/payments/charge")
                .description("Total de erros HTTP")
                .register(meterRegistry);

        // Latência com percentis
        this.requestDuration = Timer.builder("http_request_duration_ms")
                .tag("service", "payment-service").tag("route", "/payments/charge")
                .description("Latência das requisições em ms")
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(meterRegistry);

        // Saturação: requisições simultâneas
        Gauge.builder("http_active_requests", activeRequests, AtomicInteger::get)
                .tag("service", "payment-service")
                .description("Requisições em processamento simultâneo")
                .register(meterRegistry);
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok", "service", "payment-service");
    }

    @PostMapping("/charge")
    public Map<String, Object> charge(@RequestBody Map<String, Object> body) throws InterruptedException {
        activeRequests.incrementAndGet();
        requestsTotal.increment();
        var timer = Timer.start();

        try {
            var orderId = (String) body.get("orderId");
            var userId  = (String) body.get("userId");
            var amount  = new BigDecimal(body.get("amount").toString());

            var span    = tracer.currentSpan();
            var traceId = span != null ? span.context().traceId() : "no-trace";
            var spanId  = span != null ? span.context().spanId()  : "no-span";

            log.info("Iniciando cobrança - orderId={} userId={} amount={} traceId={} step=payment-start",
                    orderId, userId, amount, traceId);

            // Span filho: validação do cartão
            var validateSpan = tracer.nextSpan().name("card.validate").start();
            try (var ws = tracer.withSpan(validateSpan)) {
                log.info("Validando cartão - orderId={} traceId={} step=card-validate", orderId, traceId);
                Thread.sleep(25);
                validateSpan.tag("card.validated", "true");
            } finally {
                validateSpan.end();
            }

            // Persiste no PostgreSQL — span de DB gerado automaticamente pelo Spring Data
            var transactionId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            log.info("Persistindo transação no banco - orderId={} transactionId={} traceId={} step=payment-persist",
                    orderId, transactionId, traceId);
            repository.save(new PaymentTransaction(transactionId, orderId, userId, amount, "approved", traceId));

            log.info("Cobrança concluída - orderId={} transactionId={} amount={} traceId={} step=payment-complete",
                    orderId, transactionId, amount, traceId);

            Map<String, Object> result = new HashMap<>();
            result.put("transactionId", transactionId);
            result.put("orderId", orderId);
            result.put("amount", amount);
            result.put("status", "approved");
            result.put("traceId", traceId);
            result.put("spanId", spanId);
            return result;

        } catch (Exception e) {
            errorsTotal.increment();
            throw e;
        } finally {
            timer.stop(requestDuration);
            activeRequests.decrementAndGet();
        }
    }
}
