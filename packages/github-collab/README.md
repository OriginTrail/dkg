# GitHub Collaboration — DKG App

A DKG V9 installable app that transforms GitHub repository activity into structured RDF knowledge and enables multi-node collaborative development workflows over the Decentralized Knowledge Graph.

## Features

- **GitHub to RDF** — Converts PRs, issues, reviews, commits, and branches into structured knowledge per the `ghcode:` ontology
- **Dual-mode sync** — Real-time webhooks or periodic polling with ETag/conditional requests
- **Multi-node collaboration** — Nodes subscribe to per-repo paranets and coordinate via GossipSub
- **Collaborative reviews** — Multi-reviewer consensus via on-chain context graphs (M/N signatures)
- **Graph visualization** — Force-directed RDF graph views with 5 prebuilt ViewConfigs (Code Structure, PR Impact, etc.)
- **SPARQL queries** — Query the local knowledge graph with full SPARQL 1.1 support

## Installation

Add the package to the monorepo root dependencies:

```json
{
  "dependencies": {
    "@origintrail-official/dkg-app-github-collab": "workspace:*"
  }
}
```

Then install and build:

```bash
pnpm install
pnpm turbo build --filter=@origintrail-official/dkg-app-github-collab
```

The app is automatically discovered by the DKG daemon via the `dkgApp` manifest in `package.json`:

```json
{
  "dkgApp": {
    "id": "github-collab",
    "label": "GitHub Collaboration",
    "apiHandler": "./dist/api/handler.js",
    "staticDir": "./dist-ui"
  }
}
```

## Usage

### Starting the app

The app auto-loads when the DKG daemon starts — no per-app configuration needed:

```bash
dkg start
```

The app UI is available at `http://localhost:9200/apps/github-collab/` (or via the Apps tab in the Node UI).

### Adding a repository

```bash
curl -X POST http://localhost:9200/api/apps/github-collab/config/repo \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "OriginTrail",
    "repo": "dkg-v9",
    "githubToken": "ghp_...",
    "pollIntervalMs": 300000,
    "syncScope": ["pull_requests", "issues", "reviews", "commits"]
  }'
```

This creates a dedicated paranet (`github-collab:OriginTrail/dkg-v9`), subscribes to its GossipSub topics, and begins polling GitHub.

### Setting up webhooks (optional)

For real-time updates, configure a GitHub webhook:

1. Go to your repo's Settings > Webhooks > Add webhook
2. **Payload URL:** `https://{your-node}:9200/api/apps/github-collab/webhook`
3. **Content type:** `application/json`
4. **Events:** Pull requests, Issues, Pull request reviews, Pushes
5. **Secret:** (optional) Add a shared secret for HMAC-SHA256 validation

Pass the secret when configuring the repo:

```json
{ "owner": "...", "repo": "...", "webhookSecret": "your-secret" }
```

### Triggering a manual sync

```bash
curl -X POST http://localhost:9200/api/apps/github-collab/sync \
  -H "Content-Type: application/json" \
  -d '{ "owner": "OriginTrail", "repo": "dkg-v9" }'
```

Check sync progress:

```bash
curl "http://localhost:9200/api/apps/github-collab/sync/status?repo=OriginTrail/dkg-v9"
```

### Querying the knowledge graph

```bash
# List all open PRs
curl -X POST http://localhost:9200/api/apps/github-collab/query \
  -H "Content-Type: application/json" \
  -d '{
    "sparql": "SELECT ?pr ?title WHERE { ?pr a <https://ontology.dkg.io/ghcode#PullRequest> ; <https://ontology.dkg.io/ghcode#title> ?title ; <https://ontology.dkg.io/ghcode#state> \"open\" }",
    "repo": "OriginTrail/dkg-v9"
  }'

# CONSTRUCT query for graph visualization
curl -X POST http://localhost:9200/api/apps/github-collab/query \
  -H "Content-Type: application/json" \
  -d '{
    "sparql": "CONSTRUCT { ?s ?p ?o } WHERE { ?s a <https://ontology.dkg.io/ghcode#PullRequest> ; ?p ?o } LIMIT 200",
    "repo": "OriginTrail/dkg-v9"
  }'
```

### Multi-node collaboration

From a second node, subscribe to the same repo:

```bash
curl -X POST http://localhost:9200/api/apps/github-collab/config/repo \
  -H "Content-Type: application/json" \
  -d '{ "owner": "OriginTrail", "repo": "dkg-v9" }'
```

No GitHub token is required for collaborator nodes — they receive data via GossipSub from the primary sync node.

## API Reference

All endpoints are prefixed with `/api/apps/github-collab`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/info` | App metadata and DKG status |
| GET | `/status` | Sync status for all configured repos |
| GET | `/config` | Current configuration |
| POST | `/config/repo` | Add or update a repository |
| DELETE | `/config/repo` | Remove a repository |
| POST | `/convert-to-shared` | Convert a local repo to shared mode |
| POST | `/webhook` | GitHub webhook receiver |
| POST | `/sync` | Trigger a manual sync |
| GET | `/sync/status` | Check sync job progress |
| POST | `/query` | Execute SPARQL (SELECT or CONSTRUCT) |
| POST | `/auth/test` | Validate a GitHub personal access token |
| POST | `/review/request` | Start a collaborative review session |
| POST | `/review/submit` | Submit a review decision |
| GET | `/review/status` | Check review session status |
| POST | `/invite` | Send a collaboration invitation to a peer |
| GET | `/invitations` | List sent and received invitations |
| POST | `/invitations/:id/accept` | Accept an incoming invitation |
| POST | `/invitations/:id/decline` | Decline an incoming invitation |
| DELETE | `/invitations/:id` | Revoke a sent invitation |
| GET | `/collaborators` | List collaborators for a shared repo |
| GET | `/repos/:owner/:repo/prs` | List PRs from knowledge graph |
| GET | `/repos/:owner/:repo/prs/:number` | Get PR details |
| GET | `/repos/:owner/:repo/branches` | List branches via GitHub API |

## Ontology

The app uses the GitHub Code Ontology (`ghcode:` namespace).

- **Namespace:** `https://ontology.dkg.io/ghcode#`
- **Schema:** [`schema/github-code.ttl`](schema/github-code.ttl)
- **SHACL shapes:** [`schema/github-code-shapes.ttl`](schema/github-code-shapes.ttl)
- **SPARQL examples:** [`docs/sparql-queries.md`](docs/sparql-queries.md)

Key classes: `Repository`, `PullRequest`, `Issue`, `Commit`, `Review`, `ReviewComment`, `FileDiff`, `User`, `Branch`, `Label`

URI pattern: `urn:github:{owner}/{repo}/pr/{number}`, `urn:github:user/{login}`, etc. See [`docs/graph-retrieval.md`](docs/graph-retrieval.md) for the full URI reference.

## Development

```bash
# Build backend (TypeScript)
pnpm build:api

# Build frontend (Vite + React)
pnpm build:ui

# Build both
pnpm build

# Run tests
pnpm test

# Dev server for UI (with API proxy to localhost:9200)
pnpm dev:ui

# Clean build artifacts
pnpm clean
```

### Project structure

```
packages/github-collab/
  src/
    api/handler.ts          # REST API handler (createHandler factory)
    github/client.ts        # GitHub REST API client (native fetch)
    rdf/transformer.ts      # GitHub JSON → RDF quads
    rdf/uri.ts              # URI minting helpers + quad builders
    dkg/coordinator.ts      # DKG bridge (paranets, workspace, gossip)
    dkg/sync-engine.ts      # Webhook + polling sync engine
    dkg/protocol.ts         # GossipSub message types
    index.ts                # Public API barrel export
  ui/
    src/
      api.ts                # Frontend API client
      App.tsx               # React app with HashRouter
      components/           # AppShell, GraphCanvas
      pages/                # Overview, PRs, Graph Explorer, Settings
      lib/view-configs.ts   # Graph visualization ViewConfigs
  schema/                   # Ontology (TTL) and SHACL shapes
  docs/                     # Architecture, UX spec, query examples
```

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full system design including component diagram, data flow, multi-node collaboration protocol, and sync strategy.

## License

Apache-2.0
