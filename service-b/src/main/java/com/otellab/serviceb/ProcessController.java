package com.otellab.serviceb;

import io.micrometer.tracing.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/payments")
public class ProcessController {

    private static final Logger log = LoggerFactory.getLogger(ProcessController.class);
    private final Tracer tracer;
    private final PaymentRepository repository;

    public ProcessController(Tracer tracer, PaymentRepository repository) {
        this.tracer     = tracer;
        this.repository = repository;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok", "service", "payment-service");
    }

    @PostMapping("/charge")
    public Map<String, Object> charge(@RequestBody Map<String, Object> body) throws InterruptedException {
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

        // Persiste no PostgreSQL — span db gerado automaticamente pelo Spring Data + Micrometer
        var transactionId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        log.info("Persistindo transação no banco - orderId={} transactionId={} traceId={} step=payment-persist",
                orderId, transactionId, traceId);

        repository.save(new PaymentTransaction(transactionId, orderId, userId, amount, "approved", traceId));

        log.info("Cobrança concluída - orderId={} transactionId={} amount={} traceId={} step=payment-complete",
                orderId, transactionId, amount, traceId);

        return Map.of(
                "transactionId", transactionId,
                "orderId", orderId,
                "amount", amount,
                "status", "approved",
                "traceId", traceId,
                "spanId", spanId
        );
    }
}
