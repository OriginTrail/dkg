# Production runbook — DKG node logs → existing Grafana (polaris)

Goal: in Grafana, pick a node and see its logs for the last X hours.

**What already exists on your side** (verified 2026-06-24):
- Grafana at `https://polaris.xtrmstrngth.com` with a **Loki 2.5.0** datasource (`LOKI`, uid `RuMYFlL7z`) running on the **same host** (`http://127.0.0.1:3100`), already fed by file-tailing (job=dkg-engine, etc.).
- The **"DKG Node Logs"** dashboard is already imported (`/d/dkg-node-logs`), bound to that Loki. It's empty until a node ships.

**Architecture** (chosen because Loki 2.5.0 can't ingest OTLP natively):
```
DKG node ──OTLP/HTTP(+token)──▶ Cloudflare hostname ──▶ Alloy (on Loki host) ──Loki push──▶ Loki 2.5.0 ──▶ Grafana
   at-source redaction                                   OTLP→Loki, promotes node labels
```
Verified locally end-to-end against Loki 2.5.0: per-node label `service_instance_id`, `deployment_environment`, `level`; secrets arrive `[REDACTED]`; the dashboard's queries return clean lines + level volume.

---

## Step 1 — run Alloy on the Loki host (the polaris box)
Copy `config.alloy` + `docker-compose.alloy.yml` to the host, then:
```bash
docker compose -f docker-compose.alloy.yml up -d
docker logs <alloy-container> --tail 20   # should say "now listening", no errors
```
Alloy now listens on `0.0.0.0:4318` (OTLP/HTTP) — as set in `config.alloy` — and writes to the local Loki. (Uses `network_mode: host` to reach `127.0.0.1:3100`.) **Firewall TCP 4318 from the public internet**; only `cloudflared` on localhost (Step 2) should reach it. Reverse-proxy/tunnel both connect to it via `localhost:4318`.

## Step 2 — expose an ingest hostname via Cloudflare (no Access)
Nodes can't do interactive SSO, so this hostname must NOT have a Cloudflare Access policy. Recommended: a **Cloudflare Tunnel** (`cloudflared`) on the host:
```bash
cloudflared tunnel create dkg-logs
# route a hostname → the local Alloy OTLP port:
cloudflared tunnel route dns dkg-logs logs-ingest.xtrmstrngth.com
# ingress config: hostname logs-ingest.xtrmstrngth.com → service http://localhost:4318
cloudflared tunnel run dkg-logs
```
- **Do NOT** put a Cloudflare Access policy on `logs-ingest.xtrmstrngth.com`.
- **Firewall** TCP 4318 from the public internet (only `cloudflared` on localhost reaches it).
- **Auth:** pick a long random token (`openssl rand -hex 32`) and add a Cloudflare **WAF custom rule** (Security → WAF → Custom rules) — **exact expression** (Block action):
  ```
  (http.host eq "logs-ingest.xtrmstrngth.com" and not any(http.request.headers["authorization"][*] eq "Bearer <INGEST_TOKEN>"))
  ```
  This blocks every request to the ingest hostname that doesn't carry the exact bearer token. Put the same token in each node's `telemetry.logs.token`. (Verified end-to-end in your real Loki/Grafana via a proxy push on 2026-06-24 — the dashboard renders per-node, redacted lines.)

(Alternative without Cloudflare Tunnel: terminate TLS at your existing reverse proxy and `proxy_pass` the hostname to `127.0.0.1:4318`, enforcing the bearer header there.)

## Step 3 — point each hosted node at it
On every OriginTrail-hosted node (running a build with PR #1317), add the block from `node-config.example.json` to its `config.json`:
- `name`: **unique per node** (e.g. `testnet-core-01`, `mainnet-core-02`) — this is the Grafana Node selector value.
- `telemetry.logs.endpoint`: `https://logs-ingest.xtrmstrngth.com/v1/logs`
- `telemetry.logs.token`: the `<INGEST_TOKEN>` from Step 2.

> **⚠️ You MUST set `telemetry.logs.exporter: "otlp"`.** If `logs.exporter` is
> left unset, a node defaults to the **legacy syslog/Graylog** exporter, not
> OTLP — so nothing reaches Alloy/Loki and the dashboards stay empty. The infra
> templates must emit `"logs": { "exporter": "otlp", … }` explicitly on every
> hosted node.

Restart the node. Local logging (SQLite + daemon.log) is unaffected; this only adds the redacted OTLP copy.

**Logs vs traces/metrics (different transports, same endpoint host):** logs ship via a hand-rolled **OTLP/HTTP JSON** exporter (the OTel Logs SDK is still "Development"), while **traces and metrics use the stable OTel SDK** OTLP/protobuf exporters. The polaris setup today only has a **logs** backend (Loki via Alloy), so leave `telemetry.traces`/`telemetry.metrics` out (or set `enabled: false`) until a traces backend (Tempo) and metrics backend (Mimir/Prometheus) are provisioned — the `node-config.example.json` shows the full three-signal shape and `config.alloy` has the matching commented routing.

## Step 4 — view in Grafana
- **Per-node:** `https://polaris.xtrmstrngth.com/d/dkg-node-logs` → pick a **Node** → set the time range (top-right) → logs appear. `Level` and `Filter (regex)` narrow further; the bottom panels are volume-by-level and **RPC requests by method** (which JSON-RPC calls this node makes, and how many — the RPC-credit burn view).
- **Fleet overview:** `https://polaris.xtrmstrngth.com/d/dkg-fleet-logs` → active-node count, log volume per node, errors per node, recent fleet-wide errors, plus **RPC requests per node** and **RPC requests by method (fleet)** — use these to spot a node burning RPC credits and which method is doing it (filter by `Environment`).

Both dashboards are already imported. Optional alerts: `example-alerts.md`. Node-operator self-serve guide (any operator, their own backend): `../OPERATOR-GUIDE.md`.

---

## Notes / decisions
- **Redaction** runs on the node before anything leaves (wallet keys, mnemonics, tokens, JWTs → `[REDACTED]`); public 0x hashes/Merkle roots are kept.
- **Labels kept low-cardinality** on purpose: `service_name`, `service_instance_id` (node), `deployment_environment` (network), `dkg_node_role`. `operation_id` etc. stay inside the JSON line — filter with `| json | dkg_operation_id="..."`.
- **Don't add `operation_id`/`peer_id` as Loki labels** — high cardinality will hurt Loki 2.5.0.
- If you ever upgrade Loki to ≥3.0, you can drop Alloy's `| json | line_format` step in the dashboard and push OTLP straight to Loki's `/otlp` endpoint.
- Local validation stack (do not deploy): `docker-compose.sim.yml` (Loki 2.5.0 + Alloy) + `../send-sample-logs.mjs`.
