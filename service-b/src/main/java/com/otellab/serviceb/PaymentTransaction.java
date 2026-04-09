package com.otellab.serviceb;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.OffsetDateTime;

@Entity
@Table(name = "payment_transactions")
public class PaymentTransaction {

    @Id
    private String id;
    @Column(name = "order_id")  private String orderId;
    @Column(name = "user_id")   private String userId;
    private BigDecimal amount;
    private String status;
    @Column(name = "trace_id")  private String traceId;
    @Column(name = "created_at") private OffsetDateTime createdAt;

    public PaymentTransaction() {}

    public PaymentTransaction(String id, String orderId, String userId,
                               BigDecimal amount, String status, String traceId) {
        this.id        = id;
        this.orderId   = orderId;
        this.userId    = userId;
        this.amount    = amount;
        this.status    = status;
        this.traceId   = traceId;
        this.createdAt = OffsetDateTime.now();
    }

    public String getId()      { return id; }
    public String getOrderId() { return orderId; }
    public String getTraceId() { return traceId; }
    public String getStatus()  { return status; }
    public BigDecimal getAmount() { return amount; }
}
