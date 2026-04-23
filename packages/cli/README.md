# @origintrail-official/dkg

Command-line interface and daemon for DKG V10. This is the main entry point for running a DKG node — it manages the node lifecycle, exposes a local HTTP API, and provides commands for publishing, querying, and interacting with the network.

## Installation

```bash
npm install -g @origintrail-official/dkg
```

On supported platforms, the package performs a best-effort postinstall fetch of
the standalone MarkItDown converter into the package `bin/` directory so PDF,
DOCX, PPTX, XLSX, CSV, HTML, EPUB, and XML imports work without a separate
system-level install.

**From source** (monorepo development):

```bash
pnpm build
cd packages/cli && node ./scripts/bundle-markitdown-binaries.mjs --build-current-platform
pnpm link --global --filter @origintrail-official/dkg

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

# Create a context graph (project), write RDF, promote to SWM, publish to VM
dkg context-graph create my-project
dkg assertion import-file notes -f data.md -c my-project
dkg assertion promote notes -c my-project
dkg shared-memory publish my-project

# Query the knowledge graph
dkg query my-project -q "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10"
```

## Commands

| Command | Description |
|---------|-------------|
| `dkg init` | Interactive setup — node name, role, relay |
| `dkg start [-f]` | Start the node daemon (HTTP API + P2P); `-f` runs in foreground |
| `dkg stop` | Graceful daemon shutdown |
| `dkg status` | Node health, peer count, identity |
| `dkg logs` | Tail the daemon log |
| `dkg peers` | List connected peers and transport info |
| `dkg peer info <peer-id>` | Inspect a peer's identity and addresses |
| `dkg send <name> <msg>` | Encrypted direct message to a peer |
| `dkg chat <name>` | Interactive chat with a peer |
| `dkg context-graph create <id>` | Create a local context graph (project) |
| `dkg context-graph register <id>` | Register an existing CG on-chain (unlocks Verified Memory) |
| `dkg context-graph list` | List subscribed context graphs |
| `dkg context-graph invite <id> <peer>` | Invite a peer to a curated CG |
| `dkg context-graph subscribe <id>` | Subscribe to a CG without creating it |
| `dkg assertion import-file <name> -f <file> -c <cg>` | Import a document into Working Memory |
| `dkg assertion promote <name> -c <cg>` | Promote a WM assertion to Shared Working Memory |
| `dkg assertion query <name> -c <cg>` | Read assertion quads from WM |
| `dkg shared-memory write <cg>` | Write triples directly to Shared Working Memory |
| `dkg shared-memory publish <cg>` | Publish from SWM to Verified Memory (costs TRAC) |
| `dkg publish <cg>` | One-shot RDF publish to a context graph |
| `dkg verify <batchId>` | Propose M-of-N verification for a published batch |
| `dkg endorse <ual>` | Endorse a published Knowledge Asset |
| `dkg query [cg] -q <sparql>` | SPARQL query against the local store |
| `dkg query-remote <peer>` | Query a remote peer's knowledge store |
| `dkg subscribe <cg>` | Subscribe to a context graph and sync its data |
| `dkg sync` | Catch up on data from peers |
| `dkg index [directory]` | Index a code repository into the dev-coordination CG |
| `dkg publisher ...` | Inspect and control the async publisher (jobs, wallets, stats) |
| `dkg auth show` | Display the current API auth token |
| `dkg auth rotate` | Generate a new API auth token |
| `dkg wallet` | Show operational wallet addresses and balances |
| `dkg set-ask <amount>` | Set the node's on-chain ask (TRAC per KB·epoch) |
| `dkg openclaw setup` | Install and configure the OpenClaw adapter |
| `dkg update` | Update the node software (blue-green slots) |
| `dkg rollback` | Roll back to the previous software slot |

Run `dkg <command> --help` for per-command options.

## HTTP API

When the daemon is running, it exposes a local HTTP API (default: `http://localhost:9200`). Key endpoint groups:

- `GET /api/status`, `GET /api/info` — node status and health
- `POST /api/agent/register`, `GET /api/agent/identity` — agent identity
- `POST /api/context-graph/create`, `/register`, `/invite`, `GET /api/context-graph/list` — context graph management
- `POST /api/assertion/create`, `/{name}/write`, `/{name}/promote`, `/{name}/discard`, `/{name}/import-file`, `GET /api/assertion/{name}/history` — Working Memory assertions
- `POST /api/shared-memory/write`, `/publish` — Shared Working Memory and publishing to Verified Memory
- `POST /api/query`, `POST /api/query-remote` — SPARQL querying
- `POST /api/endorse`, `POST /api/verify`, `POST /api/update` — Verified Memory trust operations
- `GET /api/peers`, `GET /api/connections`, `GET /api/agents` — network introspection
- `GET /api/wallets/balances`, `GET /api/chain/rpc-health` — wallet and chain health
- `GET /api/events` — Server-Sent Events stream for real-time notifications
- `GET /api/apps` — list installed DKG apps

All endpoints (except public paths like `/api/status`, `/api/chain/rpc-health`, and `/.well-known/skill.md`) require an API token via `Authorization: Bearer <token>` header.

The full API surface — including request bodies, response shapes, and error codes — is documented in [`skills/dkg-node/SKILL.md`](./skills/dkg-node/SKILL.md).

## Installable Apps

The daemon includes a generic app loader that discovers and serves third-party DKG apps without any per-app code changes. Apps are npm packages with a `dkgApp` manifest in their `package.json`. The daemon:

1. **Discovers** installed apps from `node_modules` (packages with a `dkgApp` field) or explicit config.
2. **Loads** each app's API handler and invokes it for requests under `/api/apps/:appId/*`.
3. **Serves** each app's built UI (static assets) at `/apps/:appId/`.

Node runners install an app (`pnpm add <dkg-app-package>`), restart, and it appears in the Node UI sidebar. See [`docs/plans/DKG_APPS_INSTALLABLE.md`](../../docs/plans/DKG_APPS_INSTALLABLE.md) for the full design.

## Internal Dependencies

- `@origintrail-official/dkg-agent` — agent runtime, wallet, publishing, querying
- `@origintrail-official/dkg-core` — P2P node, memory model, event bus
- `@origintrail-official/dkg-publisher` — publish pipeline (SWM → VM)
- `@origintrail-official/dkg-storage` — triple-store adapters
- `@origintrail-official/dkg-chain` — blockchain abstraction
- `@origintrail-official/dkg-node-ui` — web dashboard serving
