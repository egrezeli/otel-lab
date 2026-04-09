package com.otellab.serviceb;

import io.micrometer.tracing.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class ProcessController {

    private static final Logger log = LoggerFactory.getLogger(ProcessController.class);
    private final Tracer tracer;

    public ProcessController(Tracer tracer) {
        this.tracer = tracer;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok", "service", "service-b");
    }

    @GetMapping("/process")
    public Map<String, Object> process(@RequestParam(defaultValue = "logs") String scenario) {
        var span = tracer.currentSpan();
        var traceId = span != null ? span.context().traceId() : "no-trace";
        var spanId  = span != null ? span.context().spanId()  : "no-span";

        // Cenário 1: log estruturado com campos de observabilidade
        if ("logs".equals(scenario)) {
            log.info("Processando cenário de logs estruturados - traceId={} spanId={} scenario={}",
                    traceId, spanId, scenario);
        }

        // Cenário 2: log explicitando propagação do traceId
        if ("trace".equals(scenario)) {
            log.info("TraceId propagado recebido do service-a - traceId={} spanId={} scenario={}",
                    traceId, spanId, scenario);
        }

        return Map.of(
                "service", "service-b",
                "scenario", scenario,
                "traceId", traceId,
                "spanId", spanId,
                "processed", true
        );
    }
}
