# GitHub Collaboration App — Architecture

> DKG V9 installable app for multi-agent GitHub collaboration via the Decentralized Knowledge Graph.

---

## 1. System Overview

The GitHub Collaboration app is an installable DKG app that transforms GitHub repository activity (PRs, issues, reviews, commits) into structured RDF knowledge, enabling multi-node collaborative development workflows over the DKG network.

**Runtime model:** Loaded by the DKG daemon as a plugin via the `dkgApp` manifest in `package.json`. Receives the full `DKGAgent` instance, providing access to P2P networking, RDF storage, SPARQL queries, workspace writes, and on-chain publishing.

**Core capabilities:**
- Ingest GitHub data (webhooks + polling) and transform to RDF Knowledge Assets
- Store repository knowledge in dedicated paranets
- Enable multi-node collaboration on PR reviews via workspace + GossipSub
- Provide consensus-based review approvals via context graphs
- Serve a web UI for monitoring and interaction

---

## 2. System Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DKG Daemon Process                          │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    GitHub Collab App                          │   │
│  │                                                              │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │   │
│  │  │  API Handler  │  │   GitHub     │  │   Coordinator    │   │   │
│  │  │  (REST API)   │  │   Sync       │  │   (DKG Bridge)   │   │   │
│  │  │              │  │   Engine      │  │                  │   │   │
│  │  │ /api/apps/   │  │              │  │ - Paranet mgmt   │   │   │
│  │  │ github-collab │  │ - Webhook Rx │  │ - Workspace ops  │   │   │
│  │  │ /*           │  │ - Poller     │  │ - GossipSub msg  │   │   │
│  │  │              │  │ - Rate limit │  │ - Context graphs │   │   │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │   │
│  │         │                 │                    │              │   │
│  │  ┌──────┴─────────────────┴────────────────────┴──────────┐  │   │
│  │  │                  RDF Transformer                        │  │   │
│  │  │  GitHub JSON → RDF Quads (ontology-based mapping)       │  │   │
│  │  └────────────────────────┬───────────────────────────────┘  │   │
│  │                           │                                   │   │
│  └───────────────────────────┼───────────────────────────────────┘   │
│                              │                                       │
│  ┌───────────────────────────┼───────────────────────────────────┐   │
│  │                      DKGAgent                                 │   │
│  │                                                               │   │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────┐  │   │
│  │  │ Gossip   │  │ Query    │  │ Publisher  │  │  Chain      │  │   │
│  │  │ Sub Mgr  │  │ Engine   │  │            │  │  Adapter    │  │   │
│  │  └─────────┘  └──────────┘  └───────────┘  └─────────────┘  │   │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────┐                   │   │
│  │  │ Protocol │  │ Triple   │  │ Workspace  │                   │   │
│  │  │ Router   │  │ Store    │  │ Handler    │                   │   │
│  │  └─────────┘  └──────────┘  └───────────┘                   │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
  ┌───────────┐     ┌──────────────┐     ┌──────────────┐
  │  GitHub    │     │  Other DKG   │     │  EVM Chain   │
  │  API       │     │  Nodes       │     │  (optional)  │
  │            │     │  (P2P mesh)  │     │              │
  └───────────┘     └──────────────┘     └──────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **API Handler** | HTTP request routing for `/api/apps/github-collab/*` endpoints |
| **GitHub Sync Engine** | Webhook receiver + polling fallback for GitHub data ingestion |
| **Coordinator** | Bridges app logic with DKGAgent — manages paranets, workspaces, GossipSub, context graphs |
| **RDF Transformer** | Converts GitHub API JSON responses to RDF quads per the GitHub Code Ontology |
| **DKGAgent** | Provided by daemon — P2P networking, storage, publishing, querying (not owned by app) |

---

## 3. App Integration

### Package Manifest

```json
{
  "name": "@origintrail-official/dkg-app-github-collab",
  "dkgApp": {
    "id": "github-collab",
    "label": "GitHub Collaboration",
    "apiHandler": "./dist/api/handler.js",
    "staticDir": "./dist-ui"
  }
}
```

### Handler Factory

```typescript
// src/api/handler.ts
export default function createHandler(
  agent: DKGAgent,
  config: DkgConfig,
): AppRequestHandler & { destroy: () => void }
```

The factory creates a `GitHubCollabCoordinator` (if agent is available) and returns a request handler function. The coordinator owns:
- GitHub sync engine lifecycle
- Paranet subscription management
- GossipSub message handlers
- Background polling timers

`destroy()` is called on daemon shutdown to clean up timers and connections.

### UI Hosting

The app UI is served via iframe in the Node UI's `AppHostPage` component:
- Static files from `dist-ui/` served on a separate port (cross-origin isolation)
- Auth token passed via `postMessage` handshake (`dkg-token-request` / `dkg-token`)
- API origin provided so the UI can call `/api/apps/github-collab/*`
- Sandbox: `allow-scripts allow-forms allow-popups` (no `allow-same-origin`)

---

## 4. API Endpoint Specifications

All endpoints are prefixed with `/api/apps/github-collab`.

### 4.1 Configuration

#### `GET /config`

Returns the current GitHub integration configuration.

**Response:**
```json
{
  "repos": [
    {
      "owner": "OriginTrail",
      "repo": "dkg-v9",
      "paranetId": "github-collab:OriginTrail/dkg-v9",
      "syncEnabled": true,
      "webhookSecret": "configured",
      "pollIntervalMs": 300000,
      "syncScope": ["pull_requests", "issues", "reviews", "commits"]
    }
  ],
  "defaultParanetPrefix": "github-collab",
  "githubTokenConfigured": true
}
```

#### `POST /config/repo`

Add or update a repository configuration.

**Request:**
```json
{
  "owner": "OriginTrail",
  "repo": "dkg-v9",
  "githubToken": "ghp_...",
  "webhookSecret": "optional-shared-secret",
  "pollIntervalMs": 300000,
  "syncScope": ["pull_requests", "issues", "reviews", "commits"],
  "paranetId": "custom-paranet-id"
}
```

**Response:**
```json
{
  "ok": true,
  "paranetId": "github-collab:OriginTrail/dkg-v9",
  "repoKey": "OriginTrail/dkg-v9"
}
```

#### `DELETE /config/repo`

Remove a repository configuration and unsubscribe from its paranet.

**Request:**
```json
{
  "owner": "OriginTrail",
  "repo": "dkg-v9"
}
```

### 4.2 GitHub Webhook Receiver

#### `POST /webhook`

Receives GitHub webhook payloads. Validates `X-Hub-Signature-256` if a webhook secret is configured.

**Headers:**
- `X-GitHub-Event`: Event type (e.g., `pull_request`, `issues`, `pull_request_review`)
- `X-Hub-Signature-256`: HMAC-SHA256 signature (optional, validated if webhook secret configured)
- `X-GitHub-Delivery`: Delivery GUID (used for idempotency)

**Request:** GitHub webhook JSON payload (event-specific)

**Response:**
```json
{
  "ok": true,
  "event": "pull_request",
  "action": "opened",
  "quadsWritten": 24
}
```

**Supported events:**
| Event | Actions | Effect |
|-------|---------|--------|
| `pull_request` | opened, closed, merged, synchronize, edited, reopened | Write/update PR KA to workspace |
| `pull_request_review` | submitted, edited, dismissed | Write review KA, update PR status |
| `pull_request_review_comment` | created, edited, deleted | Write comment KA |
| `issues` | opened, closed, reopened, edited, labeled | Write/update issue KA |
| `issue_comment` | created, edited, deleted | Write comment KA |
| `push` | — | Write commit KAs for new commits |
| `status` | — | Update CI status on associated PRs |

### 4.3 Sync Operations

#### `POST /sync`

Trigger a manual sync for a repository (full or incremental).

**Request:**
```json
{
  "owner": "OriginTrail",
  "repo": "dkg-v9",
  "scope": ["pull_requests", "issues"],
  "since": "2026-03-01T00:00:00Z",
  "fullSync": false
}
```

**Response:**
```json
{
  "ok": true,
  "jobId": "sync-abc123",
  "status": "queued"
}
```

#### `GET /sync/status`

Check sync job progress.

**Query params:** `?jobId=sync-abc123` or `?repo=OriginTrail/dkg-v9`

**Response:**
```json
{
  "jobId": "sync-abc123",
  "repo": "OriginTrail/dkg-v9",
  "status": "running",
  "progress": {
    "pullRequests": { "total": 45, "synced": 23 },
    "issues": { "total": 120, "synced": 120 },
    "reviews": { "total": 89, "synced": 0 }
  },
  "startedAt": "2026-03-24T12:00:00Z",
  "errors": []
}
```

### 4.4 Query

#### `POST /query`

Execute a SPARQL query scoped to a repository's paranet. Supports both SELECT and CONSTRUCT query forms. CONSTRUCT queries return N-Triples suitable for the `graph-viz` component.

**Request (SELECT):**
```json
{
  "sparql": "SELECT ?pr ?title ?state WHERE { ?pr a <ghc:PullRequest> ; <ghc:title> ?title ; <ghc:state> ?state }",
  "repo": "OriginTrail/dkg-v9",
  "includeWorkspace": true
}
```

**Response (SELECT):**
```json
{
  "result": {
    "bindings": [
      { "pr": "urn:github:pr:220", "title": "\"Fix codex review\"", "state": "\"merged\"" }
    ]
  }
}
```

**Request (CONSTRUCT — for graph visualization):**
```json
{
  "sparql": "CONSTRUCT { ?pr ?p ?o } WHERE { ?pr a <ghc:PullRequest> ; ?p ?o . FILTER(?pr = <urn:github:OriginTrail/dkg-v9/pr/220>) }",
  "repo": "OriginTrail/dkg-v9",
  "includeWorkspace": true
}
```

**Response (CONSTRUCT):**
```json
{
  "result": {
    "triples": [
      { "subject": "urn:github:OriginTrail/dkg-v9/pr/220", "predicate": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "object": "https://ontology.dkg.io/github#PullRequest" }
    ]
  }
}
```

The CONSTRUCT response format is compatible with `@origintrail-official/dkg-graph-viz`'s `RdfTriple[]` input, enabling force-directed graph rendering of PR dependency trees, review relationships, and contributor networks.

### 4.5 Collaboration

#### `GET /collaborators`

List nodes that are subscribed to the same repository paranet.

**Query params:** `?repo=OriginTrail/dkg-v9`

**Response:**
```json
{
  "collaborators": [
    {
      "peerId": "12D3KooW...",
      "name": "alice-node",
      "connected": true,
      "lastSeen": 1711324800000,
      "latencyMs": 45
    }
  ]
}
```

#### `POST /review/request`

Request a collaborative review session for a PR.

**Request:**
```json
{
  "owner": "OriginTrail",
  "repo": "dkg-v9",
  "prNumber": 220,
  "reviewers": ["12D3KooW..."],
  "requiredApprovals": 2
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "review-session-abc",
  "contextGraphId": "42",
  "status": "pending"
}
```

#### `POST /review/submit`

Submit a review decision for a PR.

**Request:**
```json
{
  "sessionId": "review-session-abc",
  "decision": "approve",
  "comment": "LGTM, clean implementation",
  "prNumber": 220
}
```

**Response:**
```json
{
  "ok": true,
  "decision": "approve",
  "signaturesCollected": 2,
  "signaturesRequired": 2,
  "consensusReached": true
}
```

#### `GET /review/status`

Check the status of a review session.

**Query params:** `?sessionId=review-session-abc`

**Response:**
```json
{
  "sessionId": "review-session-abc",
  "prNumber": 220,
  "repo": "OriginTrail/dkg-v9",
  "status": "approved",
  "reviews": [
    { "peerId": "12D3KooW...", "decision": "approve", "timestamp": 1711324800000 },
    { "peerId": "12D3KooW...", "decision": "approve", "timestamp": 1711324860000 }
  ],
  "contextGraphId": "42",
  "enshrined": true,
  "ual": "did:dkg:84532/0xABC.../42"
}
```

### 4.6 Knowledge Assets

#### `GET /repos/:owner/:repo/prs`

List pull requests from the local knowledge graph.

**Query params:** `?state=open&limit=50&offset=0`

**Response:**
```json
{
  "pullRequests": [
    {
      "number": 220,
      "title": "Fix codex review feedback",
      "state": "merged",
      "author": "contributor-1",
      "createdAt": "2026-03-20T10:00:00Z",
      "mergedAt": "2026-03-21T14:00:00Z",
      "reviewCount": 2,
      "ual": "did:dkg:84532/0xABC.../42"
    }
  ],
  "total": 45
}
```

#### `GET /repos/:owner/:repo/prs/:number`

Get detailed PR information including reviews, comments, and associated commits.

**Response:**
```json
{
  "number": 220,
  "title": "Fix codex review feedback",
  "body": "...",
  "state": "merged",
  "author": "contributor-1",
  "labels": ["fix"],
  "reviews": [ ... ],
  "comments": [ ... ],
  "commits": [ ... ],
  "files": [ ... ],
  "ual": "did:dkg:84532/0xABC.../42",
  "enshrined": true
}
```

### 4.7 Status

#### `GET /status`

App health and sync status overview.

**Response:**
```json
{
  "ok": true,
  "repos": [
    {
      "repoKey": "OriginTrail/dkg-v9",
      "paranetId": "github-collab:OriginTrail/dkg-v9",
      "syncStatus": "idle",
      "lastSyncAt": "2026-03-24T12:00:00Z",
      "knownPRs": 45,
      "knownIssues": 120,
      "collaborators": 3,
      "webhookActive": true
    }
  ],
  "dkgEnabled": true,
  "peerId": "12D3KooW..."
}
```

---

## 5. Data Flow

### 5.1 GitHub API to DKG Storage

```
GitHub Event (webhook or poll)
  │
  ▼
┌─────────────────────────────────┐
│ GitHub Sync Engine               │
│                                  │
│ 1. Validate webhook signature    │
│ 2. Deduplicate by delivery GUID  │
│ 3. Fetch full data if needed     │
│    (webhook payloads may be      │
│     partial — fetch via REST)    │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ RDF Transformer                  │
│                                  │
│ 1. Map GitHub JSON → RDF quads   │
│    per GitHub Code Ontology      │
│ 2. Mint entity URIs:             │
│    urn:github:{owner}/{repo}/    │
│    pr/{number}                   │
│ 3. Link to graph:                │
│    did:dkg:paranet:{paranetId}   │
│ 4. Add provenance triples        │
│    (prov:wasGeneratedBy,         │
│     prov:atTime, etc.)           │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ Coordinator                      │
│                                  │
│ Route based on data lifecycle:   │
│                                  │
│ ┌─ Ephemeral (active work) ───┐  │
│ │ writeToWorkspace()           │  │
│ │ → GossipSub workspace topic  │  │
│ │ Used for: open PRs, pending  │  │
│ │ reviews, draft comments      │  │
│ └─────────────────────────────┘  │
│                                  │
│ ┌─ Permanent (completed) ─────┐  │
│ │ publish() or                 │  │
│ │ enshrineFromWorkspace()      │  │
│ │ → Merkle proof + on-chain    │  │
│ │ Used for: merged PRs, final  │  │
│ │ reviews, release tags        │  │
│ └─────────────────────────────┘  │
└─────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ DKG Network (P2P)                │
│                                  │
│ GossipSub broadcasts to all     │
│ nodes subscribed to the          │
│ repo's paranet                   │
└─────────────────────────────────┘
```

### 5.2 Data Lifecycle Rules

| GitHub Event | Initial Storage | Final Storage | Trigger for Enshrinement |
|-------------|----------------|---------------|-------------------------|
| PR opened | Workspace | Workspace | — (stays until merged/closed) |
| PR updated (new commits) | Workspace (overwrite) | Workspace | — |
| Review submitted | Workspace | Workspace | — |
| PR merged | Workspace → Enshrine | Data graph (permanent) | Merge event |
| PR closed (not merged) | Workspace → Enshrine | Data graph (permanent) | Close event |
| Issue opened | Workspace | Workspace | — |
| Issue closed | Workspace → Enshrine | Data graph | Close event |
| Commit pushed | Workspace | Workspace → Enshrine | When associated PR merges |
| CI status update | Workspace (overwrite) | — (ephemeral) | — |

### 5.3 Root Entity Scoping

The DKG publisher requires quads to be organized around root entities for auto-partitioning into Knowledge Assets. Each root entity becomes one KA with its own Merkle proof.

**Root entity mapping for GitHub resources:**

| GitHub Resource | Root Entity URI Pattern | KA Scope |
|----------------|------------------------|----------|
| Repository | `urn:github:{owner}/{repo}` | Repo metadata (name, description, default branch) |
| Pull Request | `urn:github:{owner}/{repo}/pr/{number}` | PR + its reviews, comments, commits, files |
| Issue | `urn:github:{owner}/{repo}/issue/{number}` | Issue + its comments, labels |
| Commit | `urn:github:{owner}/{repo}/commit/{sha}` | Commit metadata (message, author, files) |
| User/Contributor | `urn:github:user/{login}` | User profile data |

**Design principle:** A PR root entity includes all directly associated data (reviews, review comments, commit refs) as triples with the PR URI as subject or linked via predicates. This means enshrining a merged PR publishes all its review history as a single KA — atomic and self-contained.

**Workspace writes** do not require root entity scoping (workspace is a flat graph). Root entities matter at enshrinement time when `enshrineFromWorkspace()` calls `autoPartition()` to split the workspace graph into KAs.

### 5.4 Query Flow

```
UI or external client
  │
  ▼
POST /api/apps/github-collab/query
  │
  ▼
Coordinator.query(sparql, repoKey)
  │
  ├─ Resolve repoKey → paranetId
  │
  ▼
agent.query(sparql, {
  paranetId,
  includeWorkspace: true   // See both active + enshrined data
})
  │
  ▼
DKGQueryEngine: wrap with GRAPH constraint
  │
  ▼
Oxigraph: execute SPARQL locally
  │
  ▼
Return bindings
```

**Important:** Queries are local-only (ADR-001). To query data from other nodes, the node must first subscribe to the paranet and sync. This happens automatically when a repo is configured.

---

## 6. Multi-Node Collaboration Protocol

### 6.1 Paranet Topology

Each configured repository gets its own paranet:

```
Paranet: github-collab:{owner}/{repo}
  │
  ├── GossipSub Topics:
  │   ├── dkg/paranet/github-collab:{owner}/{repo}/publish
  │   ├── dkg/paranet/github-collab:{owner}/{repo}/workspace
  │   ├── dkg/paranet/github-collab:{owner}/{repo}/app
  │   ├── dkg/paranet/github-collab:{owner}/{repo}/update
  │   └── dkg/paranet/github-collab:{owner}/{repo}/finalization
  │
  ├── Named Graphs:
  │   ├── did:dkg:paranet:github-collab:{owner}/{repo}           (data)
  │   ├── did:dkg:paranet:github-collab:{owner}/{repo}/_meta     (metadata)
  │   ├── did:dkg:paranet:github-collab:{owner}/{repo}/_workspace (staging)
  │   └── did:dkg:paranet:github-collab:{owner}/{repo}/_private   (access-gated)
  │
  └── Subscribed Nodes: [Node A, Node B, Node C, ...]
```

### 6.2 Node Roles

Nodes can operate in different modes depending on their configuration:

| Role | Description | GitHub Token Required | Webhook Receiver |
|------|-------------|----------------------|------------------|
| **Primary Sync** | Ingests GitHub data, serves as source of truth | Yes | Yes (recommended) |
| **Collaborator** | Subscribes to paranet, participates in reviews | No | No |
| **Observer** | Read-only access to repository knowledge | No | No |

Any node can be a primary sync node. Multiple nodes can sync the same repo — workspace CAS writes and GossipSub deduplication prevent conflicts.

### 6.3 Joining a Repository Collaboration

```
Node B wants to collaborate on OriginTrail/dkg-v9
  │
  ▼
POST /api/apps/github-collab/config/repo
  { owner: "OriginTrail", repo: "dkg-v9" }
  │
  ▼
Coordinator:
  1. ensureParanetLocal("github-collab:OriginTrail/dkg-v9")
     → Creates local paranet definition if not exists
     → Subscribes to all 5 GossipSub topics
  │
  2. syncParanetFromConnectedPeers()
     → Paged SPARQL sync from peers (500 quads/page)
     → Replicates existing PRs, issues, reviews
  │
  3. Broadcast join announcement on app topic
     { app: "github-collab", type: "node:joined", peerId: "...", repo: "..." }
  │
  ▼
Node B now receives real-time updates via GossipSub
and can participate in reviews
```

### 6.4 App-Level GossipSub Protocol

All app coordination messages use the paranet's app topic (`dkg/paranet/{id}/app`) and are JSON-serialized with an `app` field for routing:

```typescript
interface BaseMessage {
  app: 'github-collab';
  type: MessageType;
  peerId: string;
  timestamp: number;
}
```

**Message types:**

| Type | Purpose | Direction |
|------|---------|-----------|
| `node:joined` | Announce node joined the repo collaboration | Broadcast |
| `node:left` | Announce node leaving | Broadcast |
| `review:requested` | Request review participation for a PR | Broadcast |
| `review:submitted` | Announce a review decision | Broadcast |
| `review:consensus` | Announce consensus reached on a review | Broadcast |
| `sync:announce` | Announce new data available after GitHub sync | Broadcast |
| `ping` | Heartbeat for collaborator presence tracking | Broadcast |

### 6.5 Collaborative Review Protocol

```
┌─────────┐         ┌──────────┐         ┌──────────┐
│ Node A   │         │ Node B    │         │ Node C    │
│ (Leader) │         │ (Reviewer)│         │ (Reviewer)│
└────┬─────┘         └─────┬────┘         └─────┬────┘
     │                      │                     │
     │  review:requested    │                     │
     │  (PR #220, need 2    │                     │
     │   approvals)         │                     │
     ├─────────────────────►├────────────────────►│
     │                      │                     │
     │  Create context      │                     │
     │  graph on-chain      │                     │
     │  (M=2, N=3)          │                     │
     │                      │                     │
     │                      │  review:submitted   │
     │                      │  (approve)          │
     │◄─────────────────────┤                     │
     │                      │                     │
     │  Write review to     │                     │
     │  workspace (CAS)     │                     │
     │                      │                     │
     │                      │                     │  review:submitted
     │                      │                     │  (approve)
     │◄───────────────────────────────────────────┤
     │                      │                     │
     │  2/2 approvals       │                     │
     │  Collect signatures  │                     │
     │  Sign merkle root    │                     │
     │                      │                     │
     │  enshrineFromWorkspace()                   │
     │  with contextGraphId + signatures          │
     │                      │                     │
     │  review:consensus    │                     │
     ├─────────────────────►├────────────────────►│
     │                      │                     │
     │  Finalization msg    │                     │
     │  via finalization    │                     │
     │  topic               │                     │
     ├─────────────────────►├────────────────────►│
     │                      │                     │
```

### 6.6 Conflict Resolution

**Concurrent workspace writes:** Handled by DKG's CAS (Compare-And-Swap) mechanism via `writeConditionalToWorkspace()`. Each write includes conditions that must hold for the write to succeed. If a condition fails (another node wrote first), the write is rejected with `StaleWriteError` and the caller must re-read and retry.

**Multiple sync sources:** If multiple nodes sync the same PR from GitHub, workspace deduplication (same entity URI, same triples) means the data converges. GossipSub message deduplication prevents re-processing.

**Enshrinement conflicts:** Only one node can enshrine workspace data for a given root entity at a time (per-entity write locks in the publisher). The first successful enshrinement wins; subsequent attempts see the data already in the canonical graph.

---

## 7. GitHub Sync Strategy

### 7.1 Dual-Mode Sync

The sync engine supports two complementary modes:

#### Webhook Mode (Primary — Real-Time)

```
GitHub ──webhook──► DKG Daemon ──► App Handler ──► Sync Engine
                    :19200              /api/apps/github-collab/webhook
```

**Setup requirements:**
1. User configures a webhook in GitHub pointing to their DKG node's public URL
2. Webhook URL: `https://{node-host}:{port}/api/apps/github-collab/webhook`
3. Content type: `application/json`
4. Events: Pull requests, Issues, Pull request reviews, Pushes, Status
5. (Optional) Webhook secret for HMAC-SHA256 signature validation

**Webhook validation:**
```typescript
function validateWebhook(req: IncomingMessage, body: Buffer, secret?: string): boolean {
  if (!secret) return true; // No secret configured — accept all
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

#### Polling Mode (Fallback — Periodic)

Used when webhooks are not feasible (e.g., node behind NAT without public URL, development setup).

```
Poll Timer ──► GitHub REST API ──► Sync Engine
  (every N ms)     (with ETag/
                    If-Modified-Since)
```

**Polling strategy:**
- Default interval: 5 minutes (configurable per repo via `pollIntervalMs`)
- Uses conditional requests (`If-Modified-Since`, `ETag`) to minimize API quota usage
- Exponential backoff on rate limit (HTTP 429) or errors
- Tracks high-water marks per resource type (e.g., last PR `updated_at`)
- Respects GitHub API rate limits (5000 req/hr for authenticated, 60/hr unauthenticated)

### 7.2 Sync Scope

Each repository sync can be scoped to specific resource types:

| Scope | GitHub API Endpoint | Polling Strategy |
|-------|-------------------|------------------|
| `pull_requests` | `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated` | Since last `updated_at` |
| `issues` | `GET /repos/{owner}/{repo}/issues?state=all&sort=updated` | Since last `updated_at` |
| `reviews` | `GET /repos/{owner}/{repo}/pulls/{number}/reviews` | Per-PR when PR updated |
| `commits` | `GET /repos/{owner}/{repo}/pulls/{number}/commits` | Per-PR when PR updated |
| `comments` | `GET /repos/{owner}/{repo}/issues/{number}/comments` | Per-issue/PR when updated |

### 7.3 Rate Limiting and Backoff

```typescript
interface RateLimitState {
  remaining: number;       // X-RateLimit-Remaining header
  resetAt: number;         // X-RateLimit-Reset header (epoch seconds)
  retryAfter: number;      // Retry-After header (seconds) from 429
  consecutiveErrors: number;
}
```

**Policy:**
- If `remaining < 100`: reduce poll frequency by 2x
- If `remaining < 10`: pause polling until `resetAt`
- On HTTP 429: wait `retryAfter` seconds (or 60s default)
- On 5xx: exponential backoff (1s, 2s, 4s, ... up to 5min)
- On success after errors: reset backoff immediately

### 7.4 Idempotency

- Webhook deliveries are deduplicated by `X-GitHub-Delivery` GUID (stored in memory with 1hr TTL)
- Poll-based updates use `updated_at` high-water mark — re-processing the same entity is idempotent (same entity URI, same or updated triples)
- Workspace writes for the same entity URI overwrite previous state (last-writer-wins for workspace, CAS for critical state)

---

## 8. Security Model

### 8.1 GitHub Token Management

```
┌─────────────────────────────────────────────┐
│ Token Storage                                │
│                                              │
│ GitHub tokens stored in DKG node config:     │
│ ~/.dkg/config.json                           │
│   githubCollab:                              │
│     repos:                                   │
│       - owner: OriginTrail                   │
│         repo: dkg-v9                         │
│         token: <encrypted>                   │
│                                              │
│ Tokens are:                                  │
│ - Never transmitted over P2P                 │
│ - Never included in RDF quads                │
│ - Never exposed in API responses             │
│ - Scoped to minimum required permissions     │
└─────────────────────────────────────────────┘
```

**Required GitHub token scopes:**
- `repo` — read access to repository data (PRs, issues, reviews)
- (Optional) `admin:repo_hook` — if the app should auto-configure webhooks

**Token lifecycle:**
- Set via `POST /config/repo` with `githubToken` field
- Stored in node config file (same as other node secrets)
- Used only by the GitHub Sync Engine for API calls
- Never shared with other DKG nodes

### 8.2 DKG API Authentication

The app inherits the daemon's auth model:
- All `/api/apps/github-collab/*` endpoints require a valid Bearer token
- Token is loaded from `~/.dkg/auth.token`
- The Node UI passes the token to the app iframe via `postMessage`

### 8.3 Webhook Security

- Webhook payloads are validated via HMAC-SHA256 if a `webhookSecret` is configured
- Without a secret, the webhook endpoint accepts all payloads (suitable for dev/testing)
- The webhook endpoint does not require DKG auth tokens (GitHub cannot send Bearer tokens)
- Rate limiting: max 100 webhook deliveries per minute per repo (excess are queued)

### 8.4 P2P Data Security

| Data Type | Visibility | Mechanism |
|-----------|-----------|-----------|
| PR metadata (title, author, state) | Public to paranet subscribers | Workspace / publish |
| PR diffs / file contents | Not synced by default | Only stored if explicitly configured |
| Review decisions | Public to paranet subscribers | Workspace → enshrine |
| GitHub tokens | Node-local only | Never leaves the node |
| Private repo data | Access-gated | `accessPolicy: 'allowList'` with `allowedPeers` |

### 8.5 Private Repository Support

For private repositories, the app supports access-gated publishing:

```typescript
// When publishing private repo data
await agent.publish(paranetId, quads, privateQuads, {
  accessPolicy: 'allowList',
  allowedPeers: ['12D3KooW...', '12D3KooW...'], // Explicitly permitted nodes
});
```

Private data is stored in the `_private` named graph and served only to peers on the allow list via the `/dkg/access/1.0.0` P2P protocol.

---

## 9. Paranet Design

### 9.1 Paranet Strategy: Per-Repository

Each monitored repository gets a dedicated paranet:

```
Paranet ID:  github-collab:{owner}/{repo}
Example:     github-collab:OriginTrail/dkg-v9
```

**Rationale:**
- **Access control:** Different repos may have different collaborator sets
- **Data isolation:** Repository data stays separate; no cross-repo query pollution
- **Selective sync:** Nodes subscribe only to repos they care about
- **Independent lifecycle:** Repos can be added/removed without affecting others

### 9.2 Alternative: Shared Paranet (Not Recommended)

A single `github-collab` paranet for all repos was considered but rejected because:
- All subscribers would receive data for all repos (bandwidth waste)
- No per-repo access control
- Workspace operations for different repos could interfere
- Harder to reason about data ownership

### 9.3 Paranet Creation Flow

```
User configures repo via POST /config/repo
  │
  ▼
Coordinator.ensureRepoParanet(owner, repo)
  │
  ├─ paranetId = `github-collab:${owner}/${repo}`
  │
  ├─ agent.ensureParanetLocal({
  │    id: paranetId,
  │    name: `GitHub: ${owner}/${repo}`,
  │    description: `GitHub collaboration paranet for ${owner}/${repo}`
  │  })
  │
  ├─ If chain configured:
  │    → On-chain paranet registration (privacy-preserving hash commitment)
  │
  ├─ Subscribe to GossipSub topics
  │
  └─ Start sync engine for this repo
```

### 9.4 System Paranet

A system-level paranet `github-collab` (without repo suffix) stores:
- App configuration metadata (which repos are tracked across the network)
- Node capability announcements (which nodes have GitHub tokens for which repos)
- Global app state

This enables discovery: a new node can query the system paranet to find which repo paranets exist in the network.

### 9.5 Configurable Paranet IDs

The default `github-collab:{owner}/{repo}` pattern can be overridden per repo:

```json
{
  "owner": "OriginTrail",
  "repo": "dkg-v9",
  "paranetId": "my-custom-paranet"
}
```

This allows integration with existing paranets or custom naming schemes.

---

## 10. Directory Structure

```
packages/github-collab/
├── package.json              # dkgApp manifest, dependencies
├── tsconfig.json
├── vitest.config.ts
├── docs/
│   └── architecture.md       # This document
├── schema/
│   ├── github-code.ttl       # OWL ontology for GitHub concepts
│   └── github-code.shacl.ttl # SHACL shapes for validation
├── src/
│   ├── index.ts              # Package entry (re-exports)
│   ├── api/
│   │   └── handler.ts        # createHandler() factory + route dispatch
│   ├── dkg/
│   │   ├── coordinator.ts    # DKG bridge (paranets, workspace, gossip)
│   │   ├── protocol.ts       # GossipSub message types + serialization
│   │   └── rdf.ts            # RDF quad helpers, URI minting, ontology constants
│   ├── github/
│   │   ├── sync-engine.ts    # Webhook receiver + polling engine
│   │   ├── client.ts         # GitHub REST API client (rate-limited)
│   │   ├── transformer.ts    # GitHub JSON → RDF quad transformation
│   │   └── types.ts          # GitHub API response types
│   └── review/
│       ├── session.ts        # Collaborative review session management
│       └── consensus.ts      # Context graph + signature collection
├── test/
│   ├── handler.test.ts
│   ├── coordinator.test.ts
│   ├── sync-engine.test.ts
│   ├── transformer.test.ts
│   ├── client.test.ts
│   ├── session.test.ts
│   └── consensus.test.ts
└── ui/                       # React UI (Vite)
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── App.tsx
        ├── pages/
        │   ├── Dashboard.tsx
        │   ├── RepoView.tsx
        │   ├── PRDetail.tsx
        │   └── ReviewSession.tsx
        └── components/
            └── ...
```

---

## 11. Dependencies

### Runtime Dependencies

| Package | Purpose |
|---------|---------|
| `@origintrail-official/dkg-agent` | DKGAgent type (peer dependency) |
| `@origintrail-official/dkg-core` | Constants, crypto, event types (peer dependency) |
| `@origintrail-official/dkg-storage` | Quad type (peer dependency) |

### Dev Dependencies

| Package | Purpose |
|---------|---------|
| `typescript` | Build |
| `vitest` | Testing |
| `@vitejs/plugin-react` | UI build |
| `react`, `react-dom` | UI framework |
| `vite` | UI bundler |

**Note:** No external GitHub client library is used. The GitHub REST API client is implemented directly using `fetch()` to minimize dependencies and control rate limiting precisely.

---

## 12. Testing Architecture

### 12.1 Unit Tests

Each module is independently testable with mock dependencies:

| Module | Mock Strategy |
|--------|--------------|
| `handler.ts` | Mock `IncomingMessage` / `ServerResponse` + mock coordinator |
| `coordinator.ts` | Mock `DKGAgent` (matching the interface used by `origin-trail-game`) |
| `sync-engine.ts` | Mock `fetch()` for GitHub API responses |
| `transformer.ts` | Pure function — GitHub JSON in, RDF quads out (no mocks needed) |
| `client.ts` | Mock `fetch()` with rate limit headers |
| `session.ts` | Mock coordinator for workspace/gossip calls |
| `consensus.ts` | Mock chain adapter for context graph operations |

**Mock DKGAgent interface** (subset used by the app):

```typescript
interface MockableAgent {
  peerId: string;
  identityId: bigint;
  gossip: {
    subscribe(topic: string): void;
    publish(topic: string, data: Uint8Array): Promise<void>;
    onMessage(topic: string, handler: Function): void;
    offMessage(topic: string, handler: Function): void;
  };
  writeToWorkspace(paranetId: string, quads: Quad[]): Promise<{ workspaceOperationId: string }>;
  writeConditionalToWorkspace(paranetId: string, quads: Quad[], conditions: CASCondition[]): Promise<{ workspaceOperationId: string }>;
  enshrineFromWorkspace(paranetId: string, selection: 'all' | { rootEntities: string[] }, opts?: any): Promise<PublishResult>;
  publish(paranetId: string, quads: Quad[]): Promise<PublishResult>;
  query(sparql: string, opts?: any): Promise<{ bindings: any[] }>;
  createContextGraph(params: any): Promise<{ contextGraphId: bigint; success: boolean }>;
  signContextGraphDigest(id: bigint, root: Uint8Array): Promise<any>;
  ensureParanetLocal(opts: any): Promise<void>;
  subscribeToParanet(id: string): void;
  syncParanetFromConnectedPeers(id: string, opts?: any): Promise<any>;
}
```

### 12.2 Integration / E2E Tests

E2E tests use `DKGAgent.create()` with `MockChainAdapter` (from `@origintrail-official/dkg-chain`) and an in-memory `OxigraphStore`:

```typescript
const agent = await DKGAgent.create({
  name: 'test-node',
  listenHost: '127.0.0.1',
  listenPort: 0,
  chainAdapter: new MockChainAdapter(),
});
await agent.start();

const handler = createHandler(agent, { name: 'test' });
// ... test HTTP requests against handler
await agent.stop();
```

### 12.3 Validation Strategy

Since SHACL is not enforced in the DKG publish pipeline, validation is programmatic in the RDF transformer:
- Required fields checked before quad generation (fail fast)
- URI format validation for minted entity URIs
- Quad count assertions in tests (expected number of triples per resource type)
- Round-trip tests: transform → write to workspace → query back → verify

---

## 13. Open Design Decisions

### OD-1: Webhook Auto-Configuration

Should the app auto-register GitHub webhooks when a repo is configured? Requires `admin:repo_hook` scope. Simpler for users but requires more permissions.

**Current decision:** Manual webhook setup. Document the URL and events clearly.

### OD-2: File Diff Storage

Should PR file diffs be stored as RDF? Diffs can be large (megabytes) and may overwhelm the triple store. Alternative: store file-level metadata (path, additions, deletions) but not the actual diff content.

**Current decision:** Store file metadata only. Diffs are available via GitHub API on demand.

### OD-3: Cross-Repo Queries

Should a node be able to query across multiple repo paranets in a single SPARQL query? The DKG query engine scopes to a single paranet per query.

**Current decision:** No cross-repo queries in v1. Users can query individual repos and aggregate in the UI. SPARQL federation could be added later.

### OD-4: GitHub Actions Integration

Should CI/CD status (GitHub Actions workflow runs) be tracked as KAs?

**Current decision:** Deferred to v2. Track `status` webhook events for basic CI status on PRs.
