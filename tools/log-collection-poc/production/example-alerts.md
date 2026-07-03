# Example Grafana alert rules (optional, once logs are flowing)

Set these up in **Alerting → Alert rules** in Grafana (data source = your Loki).
They're documented here rather than auto-created so you control thresholds and
where notifications go (contact point / notification policy).

## 1. Node went quiet (likely down or not shipping)
A node that normally logs has produced **0 log lines in 10 minutes**.

- Query (Loki, instant): `sum by (service_instance_id) (count_over_time({service_name="dkg-node"} [10m]))`
- Condition: `IS BELOW 1`
- Evaluate every `1m`, for `10m`.
- Annotation: `Node {{ $labels.service_instance_id }} has logged nothing for 10m.`

> Note: this fires only for nodes that have logged before (it won't invent
> series for nodes that never shipped). For hard "node down" detection also
> watch the node's metrics/health endpoint.

## 2. Error spike on a node
A node logged **more than 20 ERROR lines in 5 minutes**.

- Query (Loki, instant): `sum by (service_instance_id) (count_over_time({service_name="dkg-node", level="ERROR"} [5m]))`
- Condition: `IS ABOVE 20`  (tune to your baseline)
- Evaluate every `1m`, for `5m`.
- Annotation: `Node {{ $labels.service_instance_id }} error rate high ({{ $values.A }} in 5m).`

## 3. (Optional) A secret pattern slipped through redaction
Defense-in-depth — alert if anything that looks like an un-redacted key reaches Loki.

- Query (Loki, instant): `sum(count_over_time({service_name="dkg-node"} |~ `(?i)(privatekey|mnemonic)\s*[:=]\s*[^\[]` [10m]))`
  (matches a sensitive key followed by a value that is NOT `[REDACTED]`)
- Condition: `IS ABOVE 0`
- This should always be 0; if it fires, investigate the redactor / add the field to `logs.redact`.
