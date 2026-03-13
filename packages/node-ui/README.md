# @origintrail-official/dkg-node-ui

Web dashboard for DKG V9 nodes. Provides a browser-based UI for monitoring node health, exploring the knowledge graph, running SPARQL queries, and chatting with agents.

## Features

- **Dashboard** — real-time node metrics (peers, KAs published, queries served, uptime)
- **Knowledge Explorer** — browse and search Knowledge Assets with interactive graph visualization (powered by `@origintrail-official/dkg-graph-viz`)
- **SPARQL editor** — write and execute SPARQL queries with syntax highlighting and result tables
- **Chat interface** — send messages and invoke skills on remote agents
- **Metrics & telemetry** — `DashboardDB` (SQLite) for persistent metric snapshots, `MetricsCollector` for gauges and counters, `OperationTracker` for request tracing
- **Structured logging** — `StructuredLogger` with operation context, log levels, and JSON output
- **Chat assistant** — `ChatAssistant` with configurable LLM backend for in-dashboard AI help

## Architecture

The package has two sides:

1. **Server-side** (exported as a library) — `handleNodeUIRequest()` serves the built UI assets and API endpoints; `DashboardDB`, `MetricsCollector`, and `OperationTracker` provide telemetry infrastructure
2. **Client-side** (Vite/React app) — the dashboard UI, built separately via `pnpm build:ui`

## Usage

```typescript
import { handleNodeUIRequest, initTelemetry } from '@origintrail-official/dkg-node-ui';

// In the daemon's HTTP server
if (url.startsWith('/ui')) {
  return handleNodeUIRequest(req, res);
}
```

## Development

```bash
# Start the UI dev server (hot reload)
pnpm dev:ui

# Build the production UI bundle
pnpm build:ui

# Build the full package (server + UI)
pnpm build
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration types, event bus integration
- `@origintrail-official/dkg-graph-viz` — interactive RDF graph visualization component
