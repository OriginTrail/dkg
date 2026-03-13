# DKG Node UI

**Status**: Draft
**Priority**: P1

---

## Overview

A unified web interface for operating a DKG node — monitoring,
querying, exploring, and managing — served directly from the node's
existing HTTP API port. One URL, everything a node runner needs.

Not just a monitoring dashboard: this is the **complete node
management interface** that combines observability, knowledge
exploration, graph visualization, wallet management, integration
configuration, and an AI assistant.

For operators who want to integrate with existing monitoring stacks,
the node optionally exports metrics via OpenTelemetry.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              DKG Node                                     │
│                                                                           │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────────────────────────────┐ │
│  │ @origintrail-official/dkg-core │  │ @origintrail-official/dkg-agent   │  │ @origintrail-official/dkg (daemon.ts)               │ │
│  │           │  │              │  │                                     │ │
│  │ libp2p    │  │ store ───────┼──┼─► /api/query  /api/publish         │ │
│  │ gossipsub │  │ publisher    │  │  /api/status                       │ │
│  │ Logger ───┼──┼──────────────┼──┼─► /api/metrics              ← NEW │ │
│  │           │  │ query engine │  │  /api/operations             ← NEW │ │
│  └─────┬─────┘  └──────┬───────┘  │  /api/logs                  ← NEW │ │
│        │               │          │  /api/wallets                      │ │
│        │               │          │  /api/integrations           ← NEW │ │
│        │               │          │  /ui                         ← NEW │ │
│        ▼               ▼          └──────────┬──────────────────────── │ │
│  ┌─────────────────────────────┐             │                        │ │
│  │    MetricsCollector (NEW)   │◄────────────┘                        │ │
│  │                             │                                      │ │
│  │  • System: CPU, RAM, disk   │                                      │ │
│  │  • Network: peers, bandwidth│  ┌────────────────────────────┐      │ │
│  │  • DKG: KAs, KCs, triples  │  │ ~/.dkg/node-ui.db          │      │ │
│  │  • Chain: stake, earnings   │  │ (SQLite)                   │      │ │
│  │  • Uptime: heartbeats       │  │                            │      │ │
│  │  • Operations: per request  │  │ Tables:                    │      │ │
│  │  • Logs: structured entries │  │  • metric_snapshots        │      │ │
│  └──────────┬──────────────────┘  │  • operations              │      │ │
│             │                     │  • logs                     │      │ │
│             │                     │  • query_history     ← NEW │      │ │
│             │                     │  • saved_queries     ← NEW │      │ │
│             │                     └────────────────────────────┘      │ │
│             ▼ (optional)                                              │ │
│  ┌──────────────────────┐                                             │ │
│  │  OTel Exporter (opt) │──► Prometheus / Grafana / Datadog           │ │
│  └──────────────────────┘                                             │ │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                     Node UI (React SPA @ /ui)                             │
│                                                                           │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────────────┐   │
│  │  Home   │ │ Network │ │ Explorer │ │  Ops   │ │     Wallet       │   │
│  │Dashboard│ │  Peers  │ │  SPARQL  │ │ & Logs │ │   & Economics    │   │
│  └────┬────┘ └────┬────┘ └────┬─────┘ └───┬────┘ └────────┬─────────┘   │
│       │           │           │            │               │             │
│       │      ┌────┴────┐  ┌──┴──────────┐ │  ┌────────────┴───────────┐ │
│       │      │ Integra-│  │ @origintrail-official/dkg-       │ │  │      AI Assistant      │ │
│       │      │  tions  │  │  graph-viz  │ │  │ NL → SQL + SPARQL      │ │
│       │      └─────────┘  └─────────────┘ │  └────────────────────────┘ │
│       ▼                                   ▼                             │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                    /api/* endpoints (fetch)                         │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Storage sizing

SQLite is the right choice for a single-node dashboard. Here's why:

```
Metric snapshots (every 2 min):
  720 rows/day × ~500 bytes = 360 KB/day
  30 days  =  10.8 MB
  1 year   = 131 MB

Operations log (500 ops/day — publishes, queries, syncs, messages):
  500 rows/day × ~300 bytes = 150 KB/day
  30 days  =   4.5 MB
  1 year   =  55 MB

Structured logs (5,000 entries/day):
  5,000 rows/day × ~200 bytes = 1 MB/day
  30 days  =  30 MB
  1 year   = 365 MB

────────────────────────────────────
Total after 30 days:   ~45 MB
Total after 1 year:   ~550 MB
```

SQLite routinely handles databases of tens of GB with millions of rows.
A single-writer workload (one collector) is its ideal use case.
InfluxDB/TimescaleDB would be overkill for a single node.

Retention policy: default 90 days, configurable. Auto-vacuum on startup.

---

## Dashboard panels

### Panel 1: System Health

| Metric | Source | Interval |
|--------|--------|----------|
| CPU usage (%) | `os.cpus()` | 10s |
| Memory used / total | `process.memoryUsage()` + `os.totalmem()` | 10s |
| Disk usage (data dir) | `fs.statfs()` | 60s |
| Node.js heap | `v8.getHeapStatistics()` | 10s |
| Uptime | `process.uptime()` | 10s |
| Uptime history | Heartbeat log in metrics store | — |

Visual: sparkline charts for CPU/RAM over last 24h. Green/yellow/red
status indicators. Uptime percentage badge.

### Panel 2: Network

| Metric | Source | Interval |
|--------|--------|----------|
| Connected peers (total) | `libp2p.getConnections().length` | 10s |
| Direct vs relayed peers | Connection address analysis | 10s |
| GossipSub mesh peers | `gossipsub.getMeshPeers()` | 10s |
| Subscribed paranets | `agent.listParanets()` | 60s |
| Bandwidth in/out | libp2p metrics (if enabled) | 10s |

Visual: peer count line chart over time. World map of peer locations
(from IP geolocation of connected addresses, when available).

### Panel 3: Knowledge Graph

| Metric | Source | Interval |
|--------|--------|----------|
| Total triples | `store.countQuads()` | 60s |
| Total KCs | SPARQL: count distinct `rdf:type dkg:KC` in meta graphs | 60s |
| Total KAs | SPARQL: count distinct `rdf:type dkg:KA` in meta graphs | 60s |
| Triples per paranet | `store.countQuads(graphUri)` per paranet | 60s |
| Store size on disk | Backend-dependent: `fs.stat(store.nq)` for Oxigraph, N/A for remote stores (Blazegraph) | 60s |
| Confirmed vs tentative | SPARQL: count by `dkg:status` | 60s |

Visual: donut chart (triples by paranet), bar chart (KCs over time),
number cards for totals.

### Panel 4: Economics

| Metric | Source | Interval |
|--------|--------|----------|
| Operational wallet balances | `provider.getBalance()` per wallet | 60s |
| TRAC token balance | ERC20 `balanceOf()` | 60s |
| Node stake (total) | Chain: `StakingStorage.getStake()` | 300s |
| Earnings (current epoch) | Chain: `getNodeRewards()` | 300s |
| Earnings history | Cached from chain events | on-demand |
| RPC endpoint health | `provider.getBlockNumber()` latency | 30s |

Visual: TRAC balance line chart, earnings bar chart per epoch,
RPC latency sparkline with red threshold line.

### Panel 5: Knowledge Explorer

The **core knowledge interface** — browse, query, and visualize everything
in your node's knowledge graph. Built on the existing `/api/query` and
`/api/publish` endpoints, with `@origintrail-official/dkg-graph-viz` for interactive visualization.

#### SPARQL Editor

Full-featured query editor with:
- Syntax highlighting and autocompletion (prefix suggestions, predicate hints)
- Query history (stored in SQLite alongside operations)
- Saved queries (user-defined bookmarks)
- Pre-built query templates: "All agents", "KCs in paranet X",
  "Triples about entity Y", "Confirmed vs tentative KCs"

Results render in three modes:

| Mode | When to use |
|------|-------------|
| **Table** | SELECT queries — standard tabular results |
| **Graph** | CONSTRUCT/DESCRIBE queries — interactive force-directed graph via `@origintrail-official/dkg-graph-viz` |
| **JSON** | Raw bindings — for debugging or copy-paste |

#### Graph Visualization

Powered by `@origintrail-official/dkg-graph-viz` (already in the monorepo), **as the main Explorer view**:
- The **Graph** tab loads the full knowledge graph via `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT N` (configurable limit: 1k–50k).
- Interactive force-directed 2D layout; humanized labels; node click for details.
- Interactive force-directed 2D layout (with optional 3D via `renderer-3d`)
- Click a node → expand its triples (fetch neighbors on demand)
- Color-coded by `rdf:type` or paranet
- Provenance overlay: show which KC/KA a triple belongs to
- Timeline overlay: filter by `dkg:publishedAt` date range
- Export as SVG/PNG

The graph-viz package already has:
- `RemoteSparqlSource` — connects to the node's `/api/query` endpoint
- `RdfGraph` React component with `useRdfGraph` hook
- Turtle, N-Triples, JSON-LD parsers
- Hexagon painter, label resolver, prefix manager, style engine

#### Paranet Browser

- List all paranets → click to see KCs in that paranet
- KC detail view: UAL, merkle root, status, publisher, timestamp, KA list
- KA detail view: root entity, triple count, private/public flag
- Click root entity → opens in Graph Visualization

#### Publish UI

Simple form for publishing triples to a paranet:
- Paranet selector (dropdown of subscribed paranets)
- Turtle/N-Triples text input with syntax highlighting
- Preview (parsed triples displayed as table)
- Publish button → calls `/api/publish` → shows result with UAL

---

### Panel 6: Operations & Logs

**This is the operational intelligence panel.** Every request the node
processes (publish, query, sync, message, access) is tracked as an
"operation" — correlated by the `operationId` that already flows
through the Logger.

#### Operations table

| Column | Description |
|--------|-------------|
| `operationId` | UUID (already generated by `createOperationContext`) |
| `operationName` | `publish` / `query` / `sync` / `connect` / `system` |
| `startedAt` | Timestamp |
| `durationMs` | How long the operation took |
| `status` | `success` / `error` / `in_progress` |
| `peerId` | Remote peer involved (if any) |
| `paranetId` | Paranet involved (if any) |
| `details` | JSON blob with operation-specific data |
| `tripleCount` | Number of triples processed (for publish/sync) |
| `errorMessage` | Error message if status = error |

Visual: table with filterable columns. Click a row to expand the
full operation detail + all associated log entries.

Summary cards at the top:
- Operations per hour (line chart)
- Success rate (%)
- Avg duration by operation type (bar chart)
- Busiest operation type (donut chart)

#### Log explorer

Full-text search across structured log entries, filterable by:
- **operationId** — see all log lines for a specific operation
- **level** — info / warn / error
- **module** — DKGAgent, Publisher, ChainEventPoller, etc.
- **time range** — from/to date picker
- **free text** — full-text search across message content

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Search logs...                    [info ▾] [All modules ▾] │
├─────────────────────────────────────────────────────────────┤
│ 16:45:03 publish a3f2...  [DKGPublisher] Publishing 12 triples  │
│ 16:45:03 publish a3f2...  [DKGPublisher] Merkle root: 0x7bc...  │
│ 16:45:04 publish a3f2...  [GossipSub]    Broadcast to 3 peers   │
│ 16:45:04 publish a3f2...  [PublishHndlr] Received ack from 12D..│
│ 16:45:05 publish a3f2...  [EVMAdapter]   Submitting tx 0xabc...  │
│ 16:45:15 publish a3f2...  [EVMAdapter]   Tx confirmed block 123 │
│ 16:45:15 publish a3f2...  [DKGPublisher] Status: confirmed       │
│                                                                   │
│ 16:46:01 sync   b7e1...  [DKGAgent]     Syncing from 12D3Koo... │
│ 16:46:02 sync   b7e1...  [DKGAgent]     Page 1: 500 triples     │
│ 16:46:02 sync   b7e1...  [DKGAgent]     Page 2: 123 triples     │
│ 16:46:02 sync   b7e1...  [DKGAgent]     Verified 3 KCs          │
│ 16:46:02 sync   b7e1...  [DKGAgent]     Sync complete: 623 ok   │
└─────────────────────────────────────────────────────────────┘
```

Clicking an `operationId` jumps to the Operations panel with that
operation's full detail view.

### Panel 7: Wallet Management

Interactive (not just metrics):

- **List wallets**: admin + operational keys with balances
- **Add operational key**: generate new wallet, register on-chain
- **Collect operator fees**: trigger fee withdrawal tx
- **Fund operational wallets**: transfer ETH/TRAC between wallets
- **RPC management**: show configured RPCs, latency, switch primary

### Panel 8: Integrations

Manage external adapters and extensions from the UI:

#### Adapter Management
- **List installed adapters**: ElizaOS, OpenClaw, custom adapters
- **Enable / disable**: toggle adapters on/off without restarting
- **Configure**: per-adapter settings (API keys, endpoints, models)
- **Status**: connection health, last heartbeat, error count

#### Skill Registry
- **Browse registered skills**: name, description, input/output schemas
- **Test skills**: invoke a skill manually with sample input, inspect output
- **Register new skill**: upload or point to a skill definition

#### Paranet Subscriptions
- **List subscribed paranets**: name, UAL, KC count, last sync time
- **Subscribe / unsubscribe**: join or leave a paranet from the UI
- **Paranet health**: sync lag, peer count, data freshness

#### Webhooks & Events
- **Configure outbound webhooks**: notify external systems on events
  (new KC published, sync completed, query threshold exceeded)
- **Event log**: recent webhook deliveries with status codes

---

### Panel 9: AI Assistant

Embedded chatbot powered by the node's own DKG agent capabilities:

- "What's my node's uptime this week?"
- "How many triples did I receive yesterday?"
- "Is my stake earning above average?"
- "Show me all KCs published to the testing paranet"
- "Show me all failed operations in the last hour"
- "Which peer sent me the most data?"

The chatbot queries the metrics store (SQLite), the operations log,
and the triple store. **Optional LLM**: when `llm` is set in `~/.dkg/config.json`
(OpenAI-compatible: `apiKey`, `model`, `baseURL`), unmatched questions are
sent to the LLM; if the response contains a SPARQL code block it is executed
and results are appended (NL→SPARQL).

---

## Implementation approach

### Package: `@origintrail-official/dkg-node-ui`

New package containing:

**Backend (instrumentation + API)**:
- `MetricsCollector` — gathers system, network, DKG, and chain metrics
  on a timer and stores snapshots
- `OperationTracker` — records every operation with duration and outcome
- `StructuredLogger` — drop-in replacement for `Logger` that also writes
  to SQLite with operationId correlation
- `NodeUIServer` — serves the web UI as static files on the existing
  HTTP server, mounts all API routes

**Frontend (React SPA)**:
- Built with React + Vite, pre-built at publish time to static files
- Consumes the `/api/*` endpoints for all data
- Embeds `@origintrail-official/dkg-graph-viz` for the Knowledge Explorer's graph view
- CodeMirror or Monaco for the SPARQL editor
- Recharts or similar for time-series charts
- The AI Assistant panel shares the same chat UI components
- `DashboardDB` — SQLite database manager (schema, migrations, retention)

### SQLite schema

```sql
-- Periodic metric snapshots (every 2 minutes)
CREATE TABLE metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                    -- unix timestamp (ms)
  cpu_percent REAL,
  mem_used_bytes INTEGER,
  mem_total_bytes INTEGER,
  disk_used_bytes INTEGER,
  disk_total_bytes INTEGER,
  heap_used_bytes INTEGER,
  uptime_seconds INTEGER,
  peer_count INTEGER,
  direct_peers INTEGER,
  relayed_peers INTEGER,
  mesh_peers INTEGER,
  paranet_count INTEGER,
  total_triples INTEGER,
  total_kcs INTEGER,
  total_kas INTEGER,
  store_bytes INTEGER,
  confirmed_kcs INTEGER,
  tentative_kcs INTEGER,
  rpc_latency_ms INTEGER,
  rpc_healthy INTEGER                     -- 0 or 1
);
CREATE INDEX idx_snapshots_ts ON metric_snapshots(ts);

-- Per-operation tracking (publish, query, sync, message, etc.)
CREATE TABLE operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,             -- UUID from createOperationContext
  operation_name TEXT NOT NULL,           -- publish / query / sync / connect / system
  started_at INTEGER NOT NULL,            -- unix timestamp (ms)
  duration_ms INTEGER,                    -- NULL while in progress
  status TEXT DEFAULT 'in_progress',      -- in_progress / success / error
  peer_id TEXT,                           -- remote peer (if any)
  paranet_id TEXT,                        -- paranet involved (if any)
  triple_count INTEGER,                   -- triples processed
  error_message TEXT,                     -- error message if failed
  details TEXT                            -- JSON blob for operation-specific data
);
CREATE INDEX idx_ops_operation_id ON operations(operation_id);
CREATE INDEX idx_ops_started_at ON operations(started_at);
CREATE INDEX idx_ops_name ON operations(operation_name);

-- Structured log entries (correlated by operation_id)
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                    -- unix timestamp (ms)
  level TEXT NOT NULL,                    -- info / warn / error
  operation_name TEXT,                    -- from OperationContext
  operation_id TEXT,                      -- from OperationContext
  module TEXT,                            -- Logger name (DKGAgent, Publisher, etc.)
  message TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(operation_id)
);
CREATE INDEX idx_logs_ts ON logs(ts);
CREATE INDEX idx_logs_operation_id ON logs(operation_id);
CREATE INDEX idx_logs_level ON logs(level);
CREATE INDEX idx_logs_message ON logs(message);  -- for FTS fallback

-- SPARQL query history (auto-saved on each query execution)
CREATE TABLE query_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                    -- unix timestamp (ms)
  sparql TEXT NOT NULL,                   -- the SPARQL query text
  duration_ms INTEGER,                    -- execution time
  result_count INTEGER,                   -- number of result rows/triples
  error TEXT                              -- NULL if successful
);
CREATE INDEX idx_qhist_ts ON query_history(ts);

-- User-saved query bookmarks
CREATE TABLE saved_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                     -- user-chosen name
  description TEXT,                       -- optional description
  sparql TEXT NOT NULL,                   -- the SPARQL query text
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Note: for full-text search on log messages, SQLite's FTS5 extension
can be used:

```sql
CREATE VIRTUAL TABLE logs_fts USING fts5(message, content=logs, content_rowid=id);
```

This gives instant full-text search across all log messages with no
external search engine.

### Instrumenting the existing Logger

The current `Logger` class writes to stdout. The `StructuredLogger`
wraps it to also write to SQLite:

```typescript
class StructuredLogger extends Logger {
  constructor(module: string, private db: DashboardDB) {
    super(module);
  }

  info(ctx: OperationContext, message: string): void {
    super.info(ctx, message);
    this.db.insertLog('info', ctx, this.module, message);
  }

  warn(ctx: OperationContext, message: string): void {
    super.warn(ctx, message);
    this.db.insertLog('warn', ctx, this.module, message);
  }

  error(ctx: OperationContext, message: string): void {
    super.error(ctx, message);
    this.db.insertLog('error', ctx, this.module, message);
  }
}
```

This is minimally invasive — existing code keeps using `Logger` as
before; the daemon substitutes `StructuredLogger` instances at startup.

### Operation tracking

Operations are tracked by instrumenting the agent's key methods:

```typescript
// Before:
async syncFromPeer(remotePeerId: string, ...): Promise<number> {
  const ctx = createOperationContext('sync');
  // ...
}

// After (with tracker):
async syncFromPeer(remotePeerId: string, ...): Promise<number> {
  const ctx = createOperationContext('sync');
  this.tracker.start(ctx, { peerId: remotePeerId });
  try {
    // ... existing logic ...
    this.tracker.complete(ctx, { tripleCount: totalSynced });
    return totalSynced;
  } catch (err) {
    this.tracker.fail(ctx, err);
    throw err;
  }
}
```

The `OperationTracker` is optional — if no dashboard DB is configured
(e.g., in tests), it's a no-op.

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

The collector runs on a **2-minute** interval for snapshots and stores
them in SQLite. Prunes data older than the retention period on startup.

Chain metrics (balances, stake, earnings) are collected less frequently
(5 min) to avoid RPC spam.

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
import { metrics, trace } from '@opentelemetry/api';

const meter = metrics.getMeter('dkg-node');
const tracer = trace.getTracer('dkg-node');

// Metrics (gauges, counters)
const peerCount = meter.createObservableGauge('dkg.network.peers');
const tripleCount = meter.createObservableGauge('dkg.knowledge.triples');
const cpuUsage = meter.createObservableGauge('dkg.system.cpu_percent');
const opsCounter = meter.createCounter('dkg.operations.total');
const opsErrorCounter = meter.createCounter('dkg.operations.errors');

// Traces (one span per operation)
const span = tracer.startSpan('dkg.publish', {
  attributes: { 'dkg.paranet': paranetId, 'dkg.peer': peerId },
});
// ... operation ...
span.end();
```

This automatically exports metrics AND traces to any OTel-compatible
backend (Prometheus, Grafana Tempo, Jaeger, Datadog, etc.).

The `operationId` is set as the OTel trace ID so operations are
correlated across the local dashboard AND external tracing tools.

### Web UI technology

**Recommended: React + Vite, pre-built and bundled as static files.**

The dashboard is built at package build time and served as static HTML/JS
from the node's HTTP server. No runtime bundler needed on the node.

```
GET /ui                     → serves index.html (SPA)
GET /ui/*                   → serves static assets (JS, CSS, fonts)
GET /api/metrics            → current snapshot (JSON)
GET /api/metrics/history    → time-series (params: from, to, resolution)
GET /api/operations         → operation list (params: name, status, from, to, limit)
GET /api/operations/:id     → single operation detail + associated logs
GET /api/logs               → log search (params: q, operationId, level, module, from, to)
GET /api/paranets           → subscribed paranets with counts
GET /api/query-history      → recent SPARQL queries with timing
GET /api/integrations       → adapter list with status
```

The SPA polls `/api/metrics` every 10 seconds and renders charts using
a lightweight charting library (e.g., Chart.js or uPlot).

### API endpoints (new)

| Endpoint | Method | Description |
|----------|--------|-------------|
| **Observability** | | |
| `/api/metrics` | GET | Current metric snapshot |
| `/api/metrics/history` | GET | Time-series data (params: `from`, `to`, `resolution`) |
| `/api/operations` | GET | List operations (filterable by name, status, time range) |
| `/api/operations/:id` | GET | Single operation with all associated log entries |
| `/api/logs` | GET | Search logs (full-text, by operationId, level, module, time range) |
| **Knowledge Explorer** | | |
| `/api/query` | POST | Execute SPARQL query (existing) |
| `/api/publish` | POST | Publish triples to a paranet (existing) |
| `/api/paranets` | GET | List subscribed paranets with KC/KA counts |
| `/api/paranets/:id/kcs` | GET | List KCs in a paranet |
| `/api/query-history` | GET | SPARQL query history (paginated) |
| `/api/saved-queries` | GET/POST/PUT/DELETE | Manage saved query bookmarks |
| **Wallet & Economics** | | |
| `/api/wallets/balances` | GET | All wallet balances (ETH + TRAC) |
| `/api/wallets/add-key` | POST | Generate and register new operational key |
| `/api/wallets/collect-fees` | POST | Trigger operator fee withdrawal |
| `/api/chain/rpc-health` | GET | RPC endpoint latency and block height |
| `/api/chain/stake` | GET | Node stake, delegation info, rewards |
| **Integrations** | | |
| `/api/integrations` | GET | List installed adapters with status |
| `/api/integrations/:id/toggle` | POST | Enable/disable an adapter |
| `/api/integrations/:id/config` | GET/PUT | Read/update adapter config |
| `/api/skills` | GET | List registered skills |
| `/api/skills/:id/test` | POST | Test-invoke a skill with sample input |
| **UI** | | |
| `/ui` | GET | Serve Node UI SPA |
| `/ui/*` | GET | Serve static assets |

---

## OpenTelemetry: when and why

OpenTelemetry is the right tool for **exporting metrics to external
systems** and for **distributed tracing**, but it's not the right tool
for **building the dashboard itself**. Here's the breakdown:

| Concern | OTel? | Why |
|---------|-------|-----|
| Metrics export to Prometheus/Grafana | Yes | Industry standard |
| Traces (operation spans with timing) | Yes | Designed for this |
| Structured logging | Yes | OTel log SDK for correlation |
| Local dashboard rendering | No | OTel doesn't render UIs |
| Local time-series storage | No | OTel exports, doesn't store — we use SQLite |
| Wallet management | No | Not an observability concern |
| AI chatbot | No | Custom feature |
| Log search / exploration | Partial | OTel can export logs, but local FTS needs SQLite |

**Architecture**:

```
Every operation (publish, query, sync, ...)
  │
  ├─► OperationTracker → SQLite `operations` table
  │                          │
  ├─► StructuredLogger → SQLite `logs` table (with FTS5)
  │                          │
  ├─► MetricsCollector → SQLite `metric_snapshots` table
  │         │                │
  │         │                ▼
  │         │          Dashboard API → Dashboard UI (React SPA)
  │         │
  │         └─► OTel Meter (optional) ──► Prometheus / Grafana
  │
  └─► OTel Tracer (optional) ──► Jaeger / Grafana Tempo / Datadog
```

The dashboard works out of the box with zero config (SQLite only).
Power users enable the OTel exporter to pipe into their existing stack.

---

## Implementation phases

### Phase 1: Instrumentation + Storage + Core API
- `DashboardDB` — SQLite schema, migrations, retention policy
- `StructuredLogger` — extends `Logger` to write to SQLite
- `OperationTracker` — start/complete/fail for each operation
- `MetricsCollector` — system, network, knowledge, chain snapshots
- Wire into daemon.ts (create DB, substitute loggers)
- API endpoints: `/api/metrics`, `/api/operations`, `/api/logs`

### Phase 2: Dashboard Home + Observability UI
- React SPA scaffold (Vite + React + routing)
- Home/dashboard panel: system health, uptime, key metrics
- Network panel: peers, connections, relay
- Operations & Logs panel: filterable table, log explorer, FTS
- Charts (Recharts) for time-series metrics

### Phase 3: Knowledge Explorer
- SPARQL editor (CodeMirror with SPARQL mode)
- Table view for SELECT results
- Graph visualization via `@origintrail-official/dkg-graph-viz` for CONSTRUCT/DESCRIBE
- Paranet browser: list paranets → KCs → KAs → root entities
- Publish UI: simple form → `/api/publish`
- Query history and saved queries (SQLite)

### Phase 4: Wallet Management + Economics — **DONE**
- Wallet balances panel (auto-refresh) — `GET /api/wallets/balances`, Wallet page
- RPC health monitoring — `GET /api/chain/rpc-health`
- Add/remove operational keys, fee collection, earnings charts, stake — future (config/manual for now)

### Phase 5: Integrations Panel — **DONE**
- Adapter list (static: ElizaOS, OpenClaw) — `GET /api/integrations`
- Skill browser (discovered skills from agents paranet)
- Paranet subscription management from UI — subscribe input + `POST /api/subscribe`
- Per-adapter config, webhook configuration — future (config file)

### Phase 6: OTel Export + AI Assistant — **PARTIAL**
- Optional OTLP exporter — interface in `telemetry.ts` (no-op until OTel packages added)
- `operationId` ↔ OTel trace ID — documented; `setOperationSpan(operationId, name)` stub
- Embedded chatbot — **DONE** (rule-based + optional LLM; SQLite + SPARQL)
- Natural language → SPARQL — **DONE** via optional LLM (config `llm` in `~/.dkg/config.json`)

---

## Dependencies

| Dependency | Purpose | Size |
|------------|---------|------|
| `better-sqlite3` | Local time-series + operations + logs | ~2MB (native) |
| `@opentelemetry/api` | Metrics/traces API (optional) | ~50KB |
| `@opentelemetry/sdk-node` | Auto-instrumentation (optional) | ~200KB |
| `@opentelemetry/exporter-metrics-otlp-http` | OTLP export (optional) | ~100KB |
| `react` + `vite` | SPA framework (build-time only) | — |
| `recharts` | Time-series charts | ~200KB |
| `@codemirror/lang-sparql` | SPARQL editor | ~50KB |
| `@origintrail-official/dkg-graph-viz` | Graph visualization (in-monorepo) | — |
