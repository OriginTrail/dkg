# DKG V10 core-node log collection — local PoC stack

Reference self-host backend for the **"Enable log collection on core nodes"**
design: an **OpenTelemetry Collector** (the engine Grafana Alloy wraps) in front
of **Grafana Loki**, viewed in **Grafana**.

```
DKG node  ──OTLP/HTTP :4318──▶  OTel Collector  ──OTLP──▶  Loki  ◀──query──  Grafana :3000
   (at-source redaction)          (batch, opt. backstop redact)   (store)        (Explore)
```

The node side is implemented in this branch:

| Concern | Where |
|---|---|
| Canonical structured record | `packages/core/src/logger.ts` (`LogRecord`, `Logger.setSink`) |
| At-source secret redaction | `packages/core/src/log-redaction.ts` (`createLogRedactor`) |
| OTLP/HTTP exporter (buffer, backoff, non-blocking) | `packages/node-ui/src/otlp-log-worker.ts` (`OtlpLogWorker`) |
| Fan-out + config + toggles | `packages/cli/src/daemon/lifecycle.ts`, `packages/cli/src/config.ts` |

## 1. Bring up the stack

```bash
cd tools/log-collection-poc
docker compose up -d
# Grafana: http://localhost:3000  (anonymous admin)
# Collector OTLP/HTTP: http://localhost:4318
# Loki API: http://localhost:3100
```

## 2a. Send sample logs (no node needed)

Drives the **real** redactor + exporter exactly as the daemon does (one sample
carries a fake private key + mnemonic to prove redaction):

```bash
# from repo root, after `pnpm turbo run build --filter=@origintrail-official/dkg-node-ui...`
node tools/log-collection-poc/send-sample-logs.mjs
```

## 2b. …or point a real node at it

Add to your `config.json` (or `<DKG_HOME>/config.json`):

```json
"telemetry": {
  "enabled": true,
  "logs": {
    "exporter": "otlp",
    "endpoint": "http://localhost:4318/v1/logs",
    "level": "info"
  }
}
```

`enabled` is the master gate (off by default → nothing leaves the node).
`exporter: "otlp"` selects this path (`"syslog"` = legacy Graylog, `"none"` =
local only). Local SQLite + `daemon.log` keep full-fidelity logs regardless.

## 3. View in Grafana

Open **http://localhost:3000 → Explore → Loki** and run:

```logql
{service_name="dkg-node"}
```

DKG fields ride along as **structured metadata** — filter with e.g.:

```logql
{service_name="dkg-node"} | dkg_network = `devnet` | dkg_operation_name = `publish`
```

Correlate a cross-node operation by its id:

```logql
{service_name="dkg-node"} | dkg_operation_id = `op-pub-1`
```

You can also confirm ingest straight from the collector log
(`docker compose logs otel-collector`) — the `debug` exporter prints every
received record. **The wallet sample line must show `[REDACTED]`** — no
`0xdeadbeef…`, no mnemonic words — proving redaction happened on the node.

## Notes

- **Alloy** is the production-grade swap for the OTel Collector here (same OTLP
  receiver → Loki path); Promtail is EOL (March 2026) — don't use it.
- The collector config has a commented-out **OTTL backstop redaction** block —
  defense-in-depth for any bare key material that reaches the body without a
  key-name (the node redactor is conservative by design to avoid nuking public
  0x hashes / Merkle roots).
- Tear down: `docker compose down -v`.
