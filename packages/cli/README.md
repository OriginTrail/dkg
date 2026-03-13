# @dkg/cli

Command-line interface and daemon for DKG V9. This is the main entry point for running a DKG node — it manages the node lifecycle, exposes a local HTTP API, and provides commands for publishing, querying, and interacting with the network.

## Installation

```bash
npm install -g @dkg/cli
```

**From source** (monorepo development):

```bash
pnpm build
pnpm link --global --filter @dkg/cli

# Binary is now available as `dkg`
dkg --help
```

## Quick Start

```bash
# Initialize a new node (generates keys, sets up config)
dkg init

# Start the node daemon
dkg start

# Check node status
dkg status

# Publish data to a paranet
dkg publish --paranet urn:paranet:example --file data.nq

# Query the knowledge graph
dkg query "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10"
```

## Commands

| Command | Description |
|---------|-------------|
| `dkg init` | Initialize node config, generate keys, set up storage |
| `dkg start` | Start the node daemon (HTTP API + P2P) |
| `dkg stop` | Stop a running daemon |
| `dkg status` | Show node status, connected peers, synced paranets |
| `dkg auth` | Generate or display API authentication token |
| `dkg publish` | Publish RDF data as Knowledge Assets to a paranet |
| `dkg query` | Run a SPARQL query against the local store |
| `dkg query-remote` | Forward a SPARQL query to a remote peer |
| `dkg peers` | List connected peers |
| `dkg send` | Send an encrypted message to another agent |
| `dkg chat` | Start an interactive chat session with a remote agent |
| `dkg subscribe` | Subscribe to a paranet and sync its data |
| `dkg paranet` | Create, list, or inspect paranets |
| `dkg workspace publish` | Publish from a local workspace (feeless mode) |
| `dkg index` | Index a local code repository into the knowledge graph |
| `dkg wallet` | Show wallet addresses and balances |
| `dkg set-ask` | Set the token ask price for serving data |
| `dkg logs` | Stream daemon logs |

## HTTP API

When the daemon is running, it exposes a local HTTP API (default: `http://localhost:9200`). Endpoints include:

- `POST /api/publish` — publish RDF data
- `POST /api/query` — execute SPARQL queries
- `GET /api/peers` — list connected peers
- `GET /api/status` — node status
- `POST /api/sessions` — create AKA sessions (experimental)
- `POST /api/context-graphs` — create a Context Graph (M/N signature-gated subgraph)
- `GET /api/context-graphs/:id` — get Context Graph metadata
- `POST /api/context-graphs/:id/publish` — publish KAs into a Context Graph
- `GET /api/oracle/:contextGraphId/entity` — entity lookup with Merkle inclusion proofs
- `POST /api/oracle/:contextGraphId/query` — SPARQL query with proofs
- `POST /api/oracle/:contextGraphId/prove` — single triple existence proof
- `GET /api/apps` — list installed DKG apps

All endpoints (except public paths and oracle endpoints) require an API token via `Authorization: Bearer <token>` header.

## Installable Apps

The daemon includes a generic app loader that discovers and serves third-party DKG apps without any per-app code changes. Apps are npm packages with a `dkgApp` manifest in their `package.json`. The daemon:

1. **Discovers** installed apps from `node_modules` (packages with a `dkgApp` field) or explicit config.
2. **Loads** each app's API handler and invokes it for requests under `/api/apps/:appId/*`.
3. **Serves** each app's built UI (static assets) at `/apps/:appId/`.

Node runners install an app (`pnpm add dkg-app-my-game`), restart, and it appears in the Node UI sidebar. See [`docs/plans/DKG_APPS_INSTALLABLE.md`](../../docs/plans/DKG_APPS_INSTALLABLE.md) for the full design.

## Internal Dependencies

- `@dkg/agent` — agent runtime, wallet, publishing, querying
- `@dkg/core` — P2P node, event bus
- `@dkg/node-ui` — web dashboard serving
