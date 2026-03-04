# @dkg/cli

Command-line interface and daemon for DKG V9. This is the main entry point for running a DKG node — it manages the node lifecycle, exposes a local HTTP API, and provides commands for publishing, querying, and interacting with the network.

## Installation

```bash
# From the monorepo
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

When the daemon is running, it exposes a local HTTP API (default: `http://localhost:8900`). Endpoints include:

- `POST /api/publish` — publish RDF data
- `POST /api/query` — execute SPARQL queries
- `GET /api/peers` — list connected peers
- `GET /api/status` — node status
- `POST /api/sessions` — create AKA sessions (experimental)

All endpoints (except public paths) require an API token via `Authorization: Bearer <token>` header.

## Internal Dependencies

- `@dkg/agent` — agent runtime, wallet, publishing, querying
- `@dkg/core` — P2P node, event bus
- `@dkg/node-ui` — web dashboard serving
