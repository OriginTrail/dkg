# Production runbook — DKG node observability

## ⭐ Current production (since 2026-07-02): dedicated observability server

Devops moved production ingest off polaris to a dedicated server running the
full three-signal stack — **OTel Collector → Loki 3.x (native OTLP) + Tempo +
VictoriaMetrics → Grafana**. The mainnet fleet ships logs there today; nodes
send OTLP straight to the collector (no Alloy bridge needed on this stack).

**Dashboards** (folder "DKG V10 Node Observability", JSONs in this directory,
import via `POST /api/dashboards/db {dashboard, folderUid, overwrite:true}`):

| uid | file | needs |
|---|---|---|
| `dkg-fleet-logs` | `grafana-dashboard-dkg-fleet-logs.json` | logs (live) |
| `dkg-node-logs` | `grafana-dashboard-dkg-node-logs.json` | logs (live) |
| `dkg-node-metrics` | `grafana-dashboard-dkg-node-metrics.json` | node metrics endpoint + collector→VictoriaMetrics route (collector self-monitoring row is live already; the two raw-RPC panels additionally need nodes on a post-PR-#1409 build, which ships `dkg.chain.rpc.requests.total`) |
| `dkg-node-traces` | `grafana-dashboard-dkg-node-traces.json` | node traces endpoint + collector→Tempo route |

Datasources are template variables (`loki` / `vm` / `tempo`) — the dashboards
bind to whatever datasources exist on import. Alerting (10 rules, 3 Slack
channels): `example-alerts.md` (importable payloads: `alert-rules.provisioning.json`).

**Query shapes differ from the polaris/Alloy stack — do not mix them up:**
- The log **line is the plain message body** (native OTLP ingest). There is
  **no** `| json | line_format "{{.body}}"` step.
- Severity is **structured metadata**: filter with `| severity_text=`ERROR``
  (values DEBUG/INFO/WARN/ERROR) or `detected_level`. There is no `level` label.
- Other metadata available per line: `dkg_module`, `dkg_operation_id`,
  `dkg_peer_id`, `dkg_chain`, `dkg_node_role`, `dkg_event_code`,
  `dkg_sync_plane`, `dkg_sync_trigger`, `dkg_outcome`, `dkg_duration_ms`, and
  `dkg_triples_synced` — filter the same way.
- `rpc_usage` accounting lines parse directly:
  `|= `rpc_usage` | logfmt | method != `` | unwrap count`.
- **Loki 3 gotcha:** *instant* metric queries over ranges ≥ a few hours are
  split internally and fail with `maximum of series (500) reached` even at tiny
  stream counts. Use **range queries** + a Grafana reduce (`sum`/`last`) for
  totals; keep instant queries to short fixed windows (e.g. `[10m]`).

**To light up metrics + traces** (node side, per node): set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector-host>:4318` (one env var
resolves the endpoints for all three signals: `/v1/traces` + `/v1/metrics` +
`/v1/logs`) or set `telemetry.metrics.endpoint` / `telemetry.traces.endpoint`
in config, restart the daemon. Collector side: add otlp-receiver pipelines
routing metrics → VictoriaMetrics and traces → Tempo (enable Tempo's
metrics-generator/spanmetrics for the traces alert). There is deliberately no
default endpoint — a node with only a logs endpoint runs traces/metrics as
silent no-ops.

> **⚠️ The env var alone does NOT switch logs to OTLP.** It only resolves
> endpoints; the log exporter *mode* is a separate switch, and an unset
> `telemetry.logs.exporter` still defaults to the **legacy syslog** path. A
> fresh node needs `telemetry.enabled: true` **and**
> `telemetry.logs.exporter: "otlp"` for logs to reach the collector — traces
> and metrics have no such mode switch and follow the resolved endpoint
> directly. (The fleet's current nodes already ship logs, so they have this
> set; this matters when provisioning new nodes from a template.)

### Verified VM / SWM sync success contract

Sync success is measured once per requested logical plane, after final
verification. A transport response or a non-zero inserted-triple count does
not count as success: partial progress followed by a timeout remains
`timeout`, local admission pressure is `deferred`, ACL rejection is `denied`,
and missing peers or authoritative graph metadata is `unreachable`. A clean
empty response is successful only when the graph is public and authoritative
metadata is present.

The metrics dashboard uses:

- `dkg_sync_plane_started_total{plane,trigger}` — accepted logical attempts;
- `dkg_sync_plane_terminal_total{plane,trigger,outcome}` — exactly one final
  outcome per started plane;
- `dkg_sync_plane_duration_milliseconds` — start-to-terminal duration;
- `dkg_sync_plane_active{plane,trigger}` — process-local in-flight attempts.

The fleet/node log dashboards use terminal events with
`dkg_event_code="sync.plane.terminal"` for outcome rates and drill-down. Do
not alert on a bare success percentage until the fleet has a representative
baseline. Any future rule must use a window longer than the configured sync
timeout and require a minimum number of terminal samples; separately alert on
a sustained started-vs-terminal gap or active attempts to expose abandoned
work without treating an in-progress transfer as a failure.

---

## Legacy: polaris setup (Loki 2.5.0 behind Alloy)

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

The local Node UI metrics collector is independent of OTLP export. Set
`telemetry.metrics.collectionEnabled` to `false` to disable local SQLite
snapshots and store scans without changing OTLP settings. See the
[Node UI metrics operator guide](../../docs/use-dkg/node-ui-metrics.md).

## Step 4 — view in Grafana
- **Per-node:** `https://polaris.xtrmstrngth.com/d/dkg-node-logs` → pick a **Node** → set the time range (top-right) → logs appear. `Level` and `Filter (regex)` narrow further; the bottom panel is volume-by-level.
- **Fleet overview:** `https://polaris.xtrmstrngth.com/d/dkg-fleet-logs` → active-node count, log volume per node, errors per node, recent fleet-wide errors (filter by `Environment`).

Both dashboards are already imported. Note: `example-alerts.md` in this directory targets the CURRENT stack (Loki 3.x structured metadata + VictoriaMetrics) — its query shapes and datasources do not apply to this legacy Loki 2.5/Alloy path; polaris keeps its own 4-rule set configured directly in its Grafana. Node-operator self-serve guide (any operator, their own backend): `tools/log-collection-poc/OPERATOR-GUIDE.md`.

---

## Notes / decisions
- **Redaction** runs on the node before anything leaves (wallet keys, mnemonics, tokens, JWTs → `[REDACTED]`); public 0x hashes/Merkle roots are kept.
- **Labels kept low-cardinality** on purpose: `service_name`, `service_instance_id` (node), `deployment_environment` (network), `dkg_node_role`. `operation_id` etc. stay inside the JSON line — filter with `| json | dkg_operation_id="..."`.
- **Don't add `operation_id`/`peer_id` as Loki labels** — high cardinality will hurt Loki 2.5.0.
- If you ever upgrade Loki to ≥3.0, you can drop Alloy's `| json | line_format` step in the dashboard and push OTLP straight to Loki's `/otlp` endpoint.
- Local validation stack (do not deploy): `docker-compose.sim.yml` (Loki 2.5.0 + Alloy) + `tools/log-collection-poc/send-sample-logs.mjs`.
