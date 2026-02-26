# Node Dashboard & Observability

**Status**: Draft
**Priority**: P1

---

## Overview

A self-contained admin dashboard served directly from the DKG node's
existing HTTP API port. Node runners get a full monitoring, management,
and analytics UI without installing any external infrastructure
(Prometheus, Grafana, etc.).

For operators who want to integrate with existing monitoring stacks,
the node optionally exports metrics via OpenTelemetry.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         DKG Node                            │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ @dkg/core │  │ @dkg/agent   │  │ @dkg/cli (daemon.ts)  │ │
│  │           │  │              │  │                       │ │
│  │ libp2p    │  │ store        │  │ HTTP API (existing)   │ │
│  │ gossipsub │  │ publisher    │  │  /api/status          │ │
│  │           │  │ query engine │  │  /api/agents          │ │
│  └─────┬─────┘  └──────┬───────┘  │  /api/metrics  ← NEW │ │
│        │               │          │  /api/wallets         │ │
│        │               │          │  /api/dashboard ← NEW │ │
│        ▼               ▼          └──────────┬────────────┘ │
│  ┌─────────────────────────────┐             │              │
│  │    MetricsCollector (NEW)   │◄────────────┘              │
│  │                             │                            │
│  │  • System: CPU, RAM, disk   │  ┌─────────────────────┐  │
│  │  • Network: peers, bandwidth│  │  metrics.db (SQLite) │  │
│  │  • DKG: KAs, KCs, triples  │  │  or metrics in       │  │
│  │  • Chain: stake, earnings   │  │  triple store        │  │
│  │  • Uptime: heartbeats       │  └─────────────────────┘  │
│  └──────────┬──────────────────┘                            │
│             │                                               │
│             ▼ (optional)                                    │
│  ┌──────────────────────┐                                   │
│  │  OTel Exporter (opt) │──► Prometheus / Grafana / Datadog │
│  └──────────────────────┘                                   │
└─────────────────────────────────────────────────────────────┘
```

## Dashboard panels

### Panel 1: System Health

| Metric | Source | Update frequency |
|--------|--------|-----------------|
| CPU usage (%) | `os.cpus()` | 10s |
| Memory used / total | `process.memoryUsage()` + `os.totalmem()` | 10s |
| Disk usage (data dir) | `fs.statfs()` | 60s |
| Node.js heap | `v8.getHeapStatistics()` | 10s |
| Uptime | `process.uptime()` | 10s |
| Uptime history | Heartbeat log in metrics store | — |

Visual: sparkline charts for CPU/RAM over last 24h. Green/yellow/red
status indicators. Uptime percentage badge.

### Panel 2: Network

| Metric | Source | Update frequency |
|--------|--------|-----------------|
| Connected peers (total) | `libp2p.getConnections().length` | 10s |
| Direct vs relayed peers | Connection address analysis | 10s |
| GossipSub mesh peers | `gossipsub.getMeshPeers()` | 10s |
| Subscribed paranets | `agent.listParanets()` | 60s |
| Bandwidth in/out | libp2p metrics (if enabled) | 10s |

Visual: peer count line chart over time. World map of peer locations
(from IP geolocation of connected addresses, when available).

### Panel 3: Knowledge Graph

| Metric | Source | Update frequency |
|--------|--------|-----------------|
| Total triples | `store.countQuads()` | 60s |
| Total KCs | SPARQL: count distinct `rdf:type dkg:KC` in meta graphs | 60s |
| Total KAs | SPARQL: count distinct `rdf:type dkg:KA` in meta graphs | 60s |
| Triples per paranet | `store.countQuads(graphUri)` per paranet | 60s |
| Store size on disk | `fs.stat(store.nq)` | 60s |
| Confirmed vs tentative | SPARQL: count by `dkg:status` | 60s |

Visual: donut chart (triples by paranet), bar chart (KCs over time),
number cards for totals.

### Panel 4: Economics

| Metric | Source | Update frequency |
|--------|--------|-----------------|
| Operational wallet balances | `provider.getBalance()` per wallet | 60s |
| TRAC token balance | ERC20 `balanceOf()` | 60s |
| Node stake (total) | Chain: `StakingStorage.getStake()` | 300s |
| Earnings (current epoch) | Chain: `getNodeRewards()` | 300s |
| Earnings history | Cached from chain events | on-demand |
| RPC endpoint health | `provider.getBlockNumber()` latency | 30s |

Visual: TRAC balance line chart, earnings bar chart per epoch,
RPC latency sparkline with red threshold line.

### Panel 5: Wallet Management

Interactive (not just metrics):

- **List wallets**: admin + operational keys with balances
- **Add operational key**: generate new wallet, register on-chain
- **Collect operator fees**: trigger fee withdrawal tx
- **Fund operational wallets**: transfer ETH/TRAC between wallets
- **RPC management**: show configured RPCs, latency, switch primary

### Panel 6: AI Assistant

Embedded chatbot powered by the node's own DKG agent capabilities:

- "What's my node's uptime this week?"
- "How many triples did I receive yesterday?"
- "Is my stake earning above average?"
- "Show me all KCs published to the testing paranet"

The chatbot queries the metrics store and the triple store using the
same SPARQL engine the node already has. For natural language → SPARQL
translation, it uses the neural query extension (see
[SPEC_PART3_EXTENSIONS.md §1](../SPEC_PART3_EXTENSIONS.md)).

---

## Implementation approach

### Package: `@dkg/dashboard`

New package containing:
- `MetricsCollector` — gathers system, network, DKG, and chain metrics
  on a timer and stores snapshots
- `DashboardServer` — serves the web UI as static files on the existing
  HTTP server
- `MetricsStore` — lightweight time-series storage (SQLite via
  `better-sqlite3`, or the node's own triple store with a metrics graph)

### Metrics collection

```typescript
interface MetricSnapshot {
  timestamp: number;
  system: {
    cpuPercent: number;
    memUsedBytes: number;
    memTotalBytes: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    heapUsedBytes: number;
    uptimeSeconds: number;
  };
  network: {
    peerCount: number;
    directPeers: number;
    relayedPeers: number;
    meshPeers: number;
    paranetCount: number;
  };
  knowledge: {
    totalTriples: number;
    totalKCs: number;
    totalKAs: number;
    storeBytes: number;
    confirmedKCs: number;
    tentativeKCs: number;
  };
  chain: {
    rpcLatencyMs: number;
    rpcHealthy: boolean;
  };
}
```

The collector runs on a 10-second interval, stores snapshots, and
prunes data older than 30 days. Chain metrics (balances, stake,
earnings) are collected less frequently (60–300s) to avoid RPC spam.

### OpenTelemetry integration

Optional, enabled via config:

```json
{
  "telemetry": {
    "enabled": true,
    "exporterType": "otlp",
    "endpoint": "http://localhost:4318"
  }
}
```

When enabled, the `MetricsCollector` registers OTel instruments:

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('dkg-node');
const peerCount = meter.createObservableGauge('dkg.network.peers');
const tripleCount = meter.createObservableGauge('dkg.knowledge.triples');
const cpuUsage = meter.createObservableGauge('dkg.system.cpu_percent');
// etc.
```

This automatically exports to any OTel-compatible backend (Prometheus,
Grafana Cloud, Datadog, etc.) without any dashboard-specific code.

### Web UI technology

**Recommended: React + Vite, pre-built and bundled as static files.**

The dashboard is built at package build time and served as static HTML/JS
from the node's HTTP server. No runtime bundler needed on the node.

```
GET /dashboard        → serves index.html (SPA)
GET /dashboard/*      → serves static assets
GET /api/metrics      → current snapshot (JSON)
GET /api/metrics/history?from=...&to=...&resolution=... → time-series
```

The SPA polls `/api/metrics` every 10 seconds and renders charts using
a lightweight charting library (e.g., Chart.js or uPlot).

### API endpoints (new)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/metrics` | GET | Current metric snapshot |
| `/api/metrics/history` | GET | Time-series data (params: `from`, `to`, `resolution`) |
| `/api/wallets/balances` | GET | All wallet balances (ETH + TRAC) |
| `/api/wallets/add-key` | POST | Generate and register new operational key |
| `/api/wallets/collect-fees` | POST | Trigger operator fee withdrawal |
| `/api/chain/rpc-health` | GET | RPC endpoint latency and block height |
| `/api/chain/stake` | GET | Node stake, delegation info, rewards |
| `/api/dashboard` | GET | Serve dashboard SPA |

---

## OpenTelemetry: when and why

OpenTelemetry is the right tool for **exporting metrics to external
systems**, but it's not the right tool for **building the dashboard
itself**. Here's the breakdown:

| Concern | OTel? | Why |
|---------|-------|-----|
| Structured metrics export | Yes | OTel is the industry standard for this |
| Traces (publish latency, sync duration) | Yes | OTel traces are perfect for this |
| Structured logging | Yes | OTel log SDK replaces ad-hoc logging |
| Dashboard rendering | No | OTel doesn't render UIs |
| Wallet management | No | Not an observability concern |
| AI chatbot | No | Custom feature |
| Time-series storage | No | OTel exports, doesn't store |

**Recommendation**: Use OTel as the **instrumentation layer** inside the
node (meters, traces, logs), with a **local exporter** that feeds the
dashboard's metrics store, and an **optional OTLP exporter** for
external backends.

```
MetricsCollector
  │
  ├─► LocalMetricsStore (always) → Dashboard API → Dashboard UI
  │
  └─► OTel OTLP Exporter (optional) → Prometheus/Grafana/Datadog
```

This way the dashboard works out of the box (zero config), but power
users can also pipe metrics into their existing monitoring infrastructure.

---

## Implementation phases

### Phase 1: Metrics collection + API
- `MetricsCollector` with system, network, and knowledge metrics
- `MetricsStore` (SQLite) with 30-day retention
- New API endpoints: `/api/metrics`, `/api/metrics/history`
- OTel instrumentation (meters for all DKG metrics)

### Phase 2: Dashboard UI
- React SPA with 5 dashboard panels
- Charts (CPU, RAM, peers, triples over time)
- Number cards (KAs, KCs, stake, balance)
- Served as static files from the node's HTTP server

### Phase 3: Wallet management
- Wallet balances panel (auto-refresh)
- Add/remove operational keys
- Fee collection UI
- RPC health monitoring

### Phase 4: AI assistant
- Embedded chatbot in dashboard
- Natural language → SPARQL for knowledge queries
- Natural language → metrics API for system queries
- Uses the node's existing agent capabilities

---

## Dependencies

| Dependency | Purpose | Size |
|------------|---------|------|
| `@opentelemetry/api` | Metrics/traces API | ~50KB |
| `@opentelemetry/sdk-node` | Auto-instrumentation | ~200KB |
| `@opentelemetry/exporter-metrics-otlp-http` | OTLP export (optional) | ~100KB |
| `better-sqlite3` | Local time-series storage | ~2MB (native) |
| `react` + `chart.js` | Dashboard UI (build-time only) | — |
