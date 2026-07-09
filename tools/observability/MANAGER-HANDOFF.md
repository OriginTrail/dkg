# Core-node log collection — status & what's needed to finish

**Goal:** in Grafana (polaris), pick a hosted node and see its logs over the last X hours.

## TL;DR
The feature is **built, merged-ready, and verified end-to-end against a real node and a real Loki 2.5.0** (same version polaris runs). Everything that can be done without production access is done. **To go live we need three access-gated actions on the polaris/Loki host + Cloudflare + node deploys** — listed at the bottom. None require further code.

## What's DONE (code) — PR #1317 (`feat/core-node-log-collection`)
- Nodes can ship logs via **OpenTelemetry (OTLP/HTTP)**, opt-in, **off by default**. Local logging (SQLite + daemon.log) is unchanged.
- **Secret redaction at the source** — wallet keys, mnemonics, tokens, JWTs become `[REDACTED]` before any log leaves the node; public hashes/Merkle roots are kept.
- **Per-node identity** emitted as labels (`service_instance_id` = node name, `deployment_environment` = testnet/mainnet) → drives the Grafana "pick a node" dropdown.
- Non-blocking exporter (bounded buffer, retry/backoff) — telemetry can never slow or crash a node.
- Reference ingest for the existing **Loki 2.5.0**: a **Grafana Alloy** bridge (Loki 2.5.0 predates native OTLP) + a ready dashboard + full runbook.

## What's VERIFIED (evidence)
- ✅ 17 unit/integration tests (redaction + OTLP exporter over a real HTTP server) + full core suite (1114) green; whole monorepo builds.
- ✅ **Real `dkg` daemon** booted with telemetry on → emitted real operational logs (`Syncing from peer…`, `Reconnect-on-gossip…`) that landed in **Loki 2.5.0** via Alloy, queryable by node.
- ✅ Redaction confirmed through the Alloy→Loki-2.5.0 bridge (a planted wallet key + mnemonic arrived `[REDACTED]`).
- ✅ Per-node + per-environment + level labels confirmed; the dashboard's exact LogQL returns clean message lines + a level-volume breakdown.
- ✅ **"DKG Node Logs" dashboard already imported into polaris** (`/d/dkg-node-logs`, bound to the `LOKI` datasource). Empty only until a node ships.

## What's BLOCKED — needs access we don't have (the ask)
1. **Loki host (the polaris box):** run Grafana Alloy there (Docker or systemd — files provided), pointed at the local Loki `127.0.0.1:3100`. → `docker-compose.alloy.yml` / `alloy.systemd.service` + `config.alloy`.
2. **Cloudflare:** publish an ingest hostname (e.g. `logs-ingest.xtrmstrngth.com`) → `localhost:4318` via a tunnel, **no Access policy**, with a bearer-token WAF rule. → `cloudflared-config.example.yml` + token (generated separately, kept out of git).
3. **Node configs / deploy pipeline:** add the `telemetry.logs` block (unique `name` per node) to each hosted testnet+mainnet node on a build that includes PR #1317, and restart. → `node-config.example.json`.

After 1–3, run `smoke-test.sh` to confirm, then open `/d/dkg-node-logs` and pick a node.

## Decisions we made (so managers don't have to)
- **OTLP over rebuilding Graylog** — vendor-neutral, redaction + structured fields, reuses existing seams.
- **Alloy bridge, not a Loki upgrade** — avoids touching the shared production Loki 2.5.0.
- **Auth at the Cloudflare edge**, not in Alloy — simpler and version-robust.
- **Off by default + opt-in + redaction** — correct for a network where nodes are independently operated (and good hygiene for our own fleet).

_Files in this folder: `config.alloy`, `docker-compose.alloy.yml`, `alloy.systemd.service`, `cloudflared-config.example.yml`, `node-config.example.json`, `smoke-test.sh`, `RUNBOOK.md` (step-by-step), `docker-compose.sim.yml` (local validation only)._
