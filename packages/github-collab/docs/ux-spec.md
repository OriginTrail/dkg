# GitHub Collaboration App — UX Specification

## 1. Overview

The GitHub Collaboration App is a DKG node application that ingests GitHub repositories into a Decentralized Knowledge Graph, enabling multi-agent code exploration, collaboration, and coordination. It runs inside the DKG node UI as a sandboxed iframe app.

**Primary users**: Developers, AI agents, and node operators who want to explore, understand, and collaborate on codebases using a knowledge graph.

---

## 2. Platform Constraints

### iframe Sandbox
- `sandbox="allow-scripts allow-forms allow-popups"` — no `allow-same-origin`
- Effective origin is `null` — no `localStorage`, `sessionStorage`, `document.cookie`
- All persistent state must go through DKG API or app backend API

### Token Handshake
```
App loads → postMessage({ type: 'dkg-token-request' }) → parent
Parent → postMessage({ type: 'dkg-token', token, apiOrigin }) → iframe
App stores token in memory → uses Authorization: Bearer <token> for all API calls
```

### API Access
- App backend API: `/api/apps/github-collab/...`
- DKG query API: `${apiOrigin}/api/query` (SPARQL)
- DKG publish API: `${apiOrigin}/api/publish`
- All calls require `Authorization: Bearer <token>` header
- CORS: API server provides `Access-Control-Allow-Origin: *`

### Build Configuration
- Vite + React, `root: 'ui'`, `base: '/apps/github-collab/'`
- `outDir: '../dist-ui'`
- Dev proxy to DKG node API

### Visual Identity
- Dark theme matching DKG node UI
- CSS custom properties: `--bg`, `--surface`, `--green`, `--border`, etc.
- Fonts: Satoshi (body), JetBrains Mono (mono), system fallbacks
- Green accent (`#4ade80`) for primary actions and active states

---

## 3. User Flows

### 3.1 Onboarding Flow

```
┌──────────────────────────────────────────────────────────┐
│                    ONBOARDING FLOW                        │
│                                                          │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐│
│  │  Paste   │──→│ Auth     │──→│ Configure│──→│ Ingest ││
│  │  GitHub  │   │ GitHub   │   │ Repo     │   │ & Sync ││
│  │  URL     │   │ PAT      │   │ Settings │   │        ││
│  └─────────┘   └──────────┘   └──────────┘   └────────┘│
│       │              │              │              │      │
│  Validate URL   Test auth     Select branches   Create   │
│  Show repo      Show scopes   Set privacy       paranet  │
│  preview        Save token    Choose filters    Start job│
│                               Set sync schedule          │
└──────────────────────────────────────────────────────────┘
```

**Step 1: Paste GitHub URL**
- Single text input: "Paste a GitHub repository URL"
- Validates format: `https://github.com/{owner}/{repo}` or `{owner}/{repo}`
- On valid URL: shows repo preview card (name, description, language, stars, visibility)
- Preview fetched via GitHub public API (no auth needed for public repos)
- For private repos: shows lock icon, prompts auth first

**Step 2: Authenticate GitHub**
- Input for GitHub Personal Access Token (PAT)
- Required scopes displayed: `repo` (for private repos), `read:org` (optional)
- "Test Connection" button validates token against GitHub API
- Success: shows green checkmark, authenticated username, token scopes
- Token stored server-side only (never in iframe storage)
- Option: "Use existing token" if previously configured

**Step 3: Configure Repository Settings**
- **Branch selection**: Multi-select of branches to track (default: main/master + open PR branches)
- **Privacy level**: Radio group
  - `workspace_only` — data stays in local node workspace (default)
  - `paranet_shared` — published to a shared paranet for collaboration
- **File filters**:
  - Include patterns (default: `**/*.{ts,js,py,sol,go,rs,java,md,json,yaml,toml}`)
  - Exclude patterns (default: `node_modules/**, dist/**, .git/**`)
  - Max file size slider (default: 100KB)
- **Sync schedule**: Dropdown
  - Manual only
  - Every 15 minutes
  - Every hour (default)
  - Every 6 hours
- **Paranet name**: Auto-generated from `github:{owner}/{repo}`, editable

**Step 4: Ingest & Sync**
- Progress display with phases:
  1. "Creating paranet..." (progress bar)
  2. "Fetching repository structure..." (file count)
  3. "Analyzing code entities..." (parsed files / total)
  4. "Building knowledge graph..." (triples created)
  5. "Indexing complete" (summary stats)
- Stats card at completion: files indexed, entities found, triples created, elapsed time
- "View Knowledge Graph" button → navigates to Graph Explorer view

### 3.2 Graph Exploration Flow

```
┌──────────────────────────────────────────────────────────────┐
│                   GRAPH EXPLORATION                           │
│                                                              │
│  ┌──────────────────┐  ┌────────────────────────────────────┐│
│  │   Sidebar         │  │   Graph Canvas                     ││
│  │                   │  │                                    ││
│  │  Repository List  │  │   ┌────┐    ┌────┐               ││
│  │  ├─ owner/repo1   │  │   │File│───→│Func│               ││
│  │  │  ├─ main       │  │   └────┘    └────┘               ││
│  │  │  └─ feat/x     │  │      │         │                  ││
│  │  └─ owner/repo2   │  │      ▼         ▼                  ││
│  │                   │  │   ┌────┐    ┌─────┐              ││
│  │  Entity Filters   │  │   │Cls │───→│Iface│              ││
│  │  ☑ Files          │  │   └────┘    └─────┘              ││
│  │  ☑ Functions      │  │                                    ││
│  │  ☑ Classes        │  ├────────────────────────────────────┤│
│  │  ☑ Imports        │  │   Node Detail Panel                ││
│  │  ☐ Packages       │  │   Name: parseConfig                ││
│  │  ☐ Commits        │  │   Type: Function                   ││
│  │                   │  │   File: src/config.ts:42            ││
│  │  Search           │  │   Calls: [validateSchema, loadEnv] ││
│  │  [____________]   │  │   Called by: [main, setupServer]   ││
│  │                   │  │                                    ││
│  └──────────────────┘  └────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Graph canvas**: `<RdfGraph>` component with custom ViewConfig (see Section 8)
- Node click → populates detail panel
- Node double-click → focus + expand neighborhood
- Background click → deselect

**Sidebar controls**:
- Repository selector (if multiple repos ingested)
- Branch selector
- Entity type filter chips (File, Function, Class, Interface, Import, Package, Commit, PR, Issue)
- Text search with debounce → highlights matching nodes
- Predicate filter chips (auto-generated from loaded data)
- "Show literals" toggle
- Triple count badge

**Detail panel** (right slide-out or bottom panel on narrow screens):
- Entity name + type badge
- File path + line number (clickable → opens in new tab if GitHub URL available)
- Relationships: outgoing edges (calls, imports, inherits) and incoming edges (called by, imported by)
- Properties table
- "Focus" button → centers graph on this node with 2-hop expansion
- "View on GitHub" link

### 3.3 Branch Visualization Flow

```
┌──────────────────────────────────────────────────────────────┐
│                   BRANCH VIEW                                 │
│                                                              │
│  Branch: [main ▾]  Compare: [feat/auth ▾]   [Diff Mode ▾]  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │   Green nodes = added in feat/auth                     │  │
│  │   Red nodes = removed/modified                         │  │
│  │   Gray nodes = unchanged                               │  │
│  │                                                        │  │
│  │          ┌──────┐                                      │  │
│  │          │ NEW  │ (green, pulsing)                     │  │
│  │          │ file │                                      │  │
│  │          └──┬───┘                                      │  │
│  │             │ imports                                   │  │
│  │          ┌──▼───┐    ┌────────┐                        │  │
│  │          │MODIFY│───→│ shared │ (gray)                 │  │
│  │          │ func │    │ util   │                        │  │
│  │          └──────┘    └────────┘                        │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Diff Summary: +3 files, ~7 functions modified, -1 class    │
└──────────────────────────────────────────────────────────────┘
```

**Controls**:
- Base branch selector
- Compare branch selector (or "Working tree")
- Diff mode: "Graph diff" (visual) | "Entity list" (table) | "File tree" (hierarchical)

**Visual encoding**:
- Added entities: green highlight, pulse animation
- Modified entities: amber highlight
- Removed entities: red highlight, reduced opacity
- Unchanged: default styling

**Diff summary bar**: counts of added/modified/removed by entity type

### 3.4 Collaboration Flow

```
┌──────────────────────────────────────────────────────────────┐
│                   COLLABORATION                               │
│                                                              │
│  ┌─────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐│
│  │ Create   │──→│ Invite    │──→│ Accept   │──→│ Shared   ││
│  │ Shared   │   │ Peers/    │   │ on other │   │ Workspace││
│  │ Paranet  │   │ Agents    │   │ node     │   │ Active   ││
│  └─────────┘   └───────────┘   └──────────┘   └──────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Create shared paranet**:
- During onboarding or from Settings, user chooses `paranet_shared` privacy
- Paranet created with URI `did:dkg:github:{owner}/{repo}`
- Node publishes repo structure as Knowledge Assets

**Invite collaborators**:
- "Invite" button on collaboration tab
- Input peer ID or select from discovered peers
- Sends paranet subscription invitation via P2P

**Shared workspace**:
- Activity feed: real-time log of who synced, what changed, agent actions
- Collaborator list with online/offline status
- Conflict indicators if multiple agents modified same entity

### 3.5 Sync Status Flow

```
┌──────────────────────────────────────────────────────────────┐
│                   SYNC STATUS                                 │
│                                                              │
│  Repository: owner/repo                                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Last Sync: 5 minutes ago          [Sync Now]       │    │
│  │  Schedule: Every hour               Status: ● Idle   │    │
│  │  Next Sync: in 55 minutes                            │    │
│  │                                                      │    │
│  │  ┌─────────────────────────────────────────────┐     │    │
│  │  │ Sync History                                │     │    │
│  │  │ ┌──────────┬──────┬──────────┬───────────┐  │     │    │
│  │  │ │ Time     │Status│ Changes  │ Duration  │  │     │    │
│  │  │ ├──────────┼──────┼──────────┼───────────┤  │     │    │
│  │  │ │ 14:32    │  ✓   │ +12 -3   │ 8.2s     │  │     │    │
│  │  │ │ 13:32    │  ✓   │ +0 -0    │ 2.1s     │  │     │    │
│  │  │ │ 12:32    │  ✗   │ Error    │ —        │  │     │    │
│  │  │ └──────────┴──────┴──────────┴───────────┘  │     │    │
│  │  └─────────────────────────────────────────────┘     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Pending Changes (from GitHub webhooks/polling):             │
│  • 2 new commits on main (abc123, def456)                    │
│  • PR #42 opened: "Add auth middleware"                      │
│  • Issue #38 closed                                          │
└──────────────────────────────────────────────────────────────┘
```

**Components**:
- Status badge: Idle / Syncing / Error
- Last sync timestamp with relative time
- Sync schedule display with next run
- Manual "Sync Now" button
- Sync history table (last 20 syncs)
- Pending changes feed (changes detected but not yet synced)

### 3.6 Agent Coordination Flow

```
┌──────────────────────────────────────────────────────────────┐
│                   AGENT COORDINATION                          │
│                                                              │
│  Active Agents (3)                                           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  ● claude-code-1  │ Reviewing PR #42   │ 3 files    │    │
│  │  ● claude-code-2  │ Analyzing imports  │ src/       │    │
│  │  ● cursor-agent   │ Idle               │ —          │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Task Board                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ CLAIMED  │  │ ACTIVE   │  │ DONE     │                  │
│  │          │  │          │  │          │                  │
│  │ Review   │  │ Refactor │  │ Fix #37  │                  │
│  │ PR #43   │  │ auth.ts  │  │ ✓        │                  │
│  │ (agent1) │  │ (agent2) │  │ (agent1) │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
│                                                              │
│  File Claims (prevents conflicts)                            │
│  ┌─────────────────────┬──────────┬─────────┐               │
│  │ File               │ Agent    │ Since   │               │
│  │ src/auth/handler.ts │ agent-1  │ 2m ago  │               │
│  │ src/api/routes.ts   │ agent-2  │ 5m ago  │               │
│  └─────────────────────┴──────────┴─────────┘               │
│                                                              │
│  Activity Log                                                │
│  14:35 agent-1 claimed src/auth/handler.ts                  │
│  14:34 agent-2 published analysis of src/api/routes.ts      │
│  14:33 agent-1 completed review of PR #42                    │
└──────────────────────────────────────────────────────────────┘
```

**Components**:
- Agent roster: online agents, current task, claimed files
- Kanban-style task board: Claimed → Active → Done
- File claim table: which agent has locked which files
- Activity log: chronological feed of agent actions (from DKG graph events)

### 3.7 PR/Issue Integration Flow

```
┌──────────────────────────────────────────────────────────────┐
│                   PR / ISSUE VIEW                             │
│                                                              │
│  [PRs] [Issues] [Commits]                                    │
│                                                              │
│  PR #42: Add auth middleware              Status: Open       │
│  Author: @developer    Branch: feat/auth → main              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Changed Files (4)          Related Entities          │    │
│  │  ┌────────────────────┐     ┌──────────────────┐     │    │
│  │  │ + auth/handler.ts  │ ──→ │ AuthHandler      │     │    │
│  │  │ + auth/middleware.ts│ ──→ │ authMiddleware() │     │    │
│  │  │ ~ api/routes.ts    │ ──→ │ registerRoutes() │     │    │
│  │  │ + test/auth.test.ts│     │                  │     │    │
│  │  └────────────────────┘     └──────────────────┘     │    │
│  │                                                      │    │
│  │  Impact Graph                                         │    │
│  │  [<RdfGraph> showing PR as focal node with changed   │    │
│  │   files, affected functions, and dependency edges]    │    │
│  │                                                      │    │
│  │  Review Status                                        │    │
│  │  ● agent-1: Approved (3 comments)                     │    │
│  │  ○ agent-2: Pending review                            │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Issue #38: Fix login timeout                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Linked PRs: #42                                      │    │
│  │  Related files: auth/handler.ts, auth/session.ts      │    │
│  │  Labels: bug, priority:high                           │    │
│  │  Agents assigned: agent-1                             │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**PR detail view**:
- PR metadata card (title, author, branch, status, labels)
- Changed files list with diff indicators (+/~/-)
- Related entities: functions/classes defined or modified in the PR
- Impact graph: `<RdfGraph>` with PR as focal node, changed files + affected entities
- Agent review status

**Issue detail view**:
- Issue metadata (title, state, labels, assignees)
- Linked PRs
- Related code entities (mentioned files, affected functions)
- Agent assignments from DKG task graph

---

## 4. Component Hierarchy

```
<App>
├── <TokenProvider>                          # postMessage handshake, stores token + apiOrigin
│   ├── <Router>                             # React Router (hash-based for iframe compat)
│   │   ├── <AppShell>                       # Top-level layout
│   │   │   ├── <TopBar>                     # Tab navigation + repo selector + sync badge
│   │   │   │   ├── <TabNav>                 # [Overview, Graph, PRs, Agents, Settings]
│   │   │   │   ├── <RepoSelector>           # Dropdown of ingested repos
│   │   │   │   └── <SyncBadge>              # Sync status indicator
│   │   │   │
│   │   │   └── <MainContent>               # Route-switched content
│   │   │       │
│   │   │       ├── <OnboardingPage>         # First-run / add repo
│   │   │       │   ├── <UrlInput>           # GitHub URL input + validation
│   │   │       │   ├── <RepoPreview>        # Fetched repo metadata card
│   │   │       │   ├── <AuthStep>           # PAT input + test connection
│   │   │       │   ├── <ConfigStep>         # Branch select, privacy, filters, schedule
│   │   │       │   └── <IngestProgress>     # Multi-phase progress display
│   │   │       │
│   │   │       ├── <OverviewPage>           # Dashboard for an ingested repo
│   │   │       │   ├── <StatCards>           # Files, entities, triples, last sync
│   │   │       │   ├── <SyncStatus>         # Sync state + history table
│   │   │       │   ├── <RecentActivity>     # Activity feed
│   │   │       │   └── <QuickActions>       # Sync now, view graph, manage
│   │   │       │
│   │   │       ├── <GraphExplorerPage>      # Knowledge graph exploration
│   │   │       │   ├── <GraphSidebar>       # Filters + search
│   │   │       │   │   ├── <BranchSelector>
│   │   │       │   │   ├── <EntityTypeFilter>
│   │   │       │   │   ├── <PredicateFilter>
│   │   │       │   │   ├── <GraphSearch>
│   │   │       │   │   └── <GraphLegend>
│   │   │       │   ├── <GraphCanvas>        # RdfGraph wrapper
│   │   │       │   │   ├── <RdfGraph>       # from @origintrail-official/dkg-graph-viz/react
│   │   │       │   │   └── <GraphHighlighter>
│   │   │       │   └── <NodeDetailPanel>    # Selected node properties + actions
│   │   │       │       ├── <EntityHeader>
│   │   │       │       ├── <RelationshipList>
│   │   │       │       ├── <PropertyTable>
│   │   │       │       └── <NodeActions>    # Focus, GitHub link, expand
│   │   │       │
│   │   │       ├── <BranchDiffPage>         # Branch comparison view
│   │   │       │   ├── <BranchPicker>       # Base + compare branch selectors
│   │   │       │   ├── <DiffSummary>        # Added/modified/removed counts
│   │   │       │   ├── <DiffGraph>          # RdfGraph with diff ViewConfig
│   │   │       │   └── <DiffEntityList>     # Table of changed entities
│   │   │       │
│   │   │       ├── <PrIssuePage>            # PRs and Issues
│   │   │       │   ├── <PrIssueNav>         # [PRs, Issues, Commits] sub-tabs
│   │   │       │   ├── <PrList>             # PR table with status badges
│   │   │       │   ├── <PrDetail>           # Single PR view
│   │   │       │   │   ├── <PrMetadata>
│   │   │       │   │   ├── <ChangedFiles>
│   │   │       │   │   ├── <ImpactGraph>    # RdfGraph with PR focal
│   │   │       │   │   └── <ReviewStatus>
│   │   │       │   ├── <IssueList>
│   │   │       │   └── <IssueDetail>
│   │   │       │       ├── <IssueMetadata>
│   │   │       │       ├── <LinkedPrs>
│   │   │       │       └── <RelatedEntities>
│   │   │       │
│   │   │       ├── <AgentsPage>             # Agent coordination
│   │   │       │   ├── <AgentRoster>        # Online agents + current tasks
│   │   │       │   ├── <TaskBoard>          # Kanban: claimed/active/done
│   │   │       │   ├── <FileClaimTable>     # Agent file locks
│   │   │       │   └── <ActivityLog>        # Chronological agent actions
│   │   │       │
│   │   │       ├── <CollaborationPage>      # Multi-node collaboration
│   │   │       │   ├── <ParanetInfo>        # Paranet details + stats
│   │   │       │   ├── <CollaboratorList>   # Peer nodes with status
│   │   │       │   ├── <InvitePeer>         # Send paranet invitation
│   │   │       │   └── <SharedActivityFeed> # Cross-node activity stream
│   │   │       │
│   │   │       └── <SettingsPage>           # Repository + app settings
│   │   │           ├── <GitHubAuthSettings> # Token management
│   │   │           ├── <SyncSettings>       # Schedule, filters, branches
│   │   │           ├── <PrivacySettings>    # Paranet privacy level
│   │   │           └── <DangerZone>         # Remove repo, delete paranet
│   │   │
│   │   └── <Toaster>                        # Toast notifications
│   │
│   └── <ErrorBoundary>
```

---

## 5. View Specifications

### 5.1 Top Bar (persistent)

| Element | Data | Interaction |
|---------|------|-------------|
| Tab navigation | Static labels: Overview, Graph, PRs, Agents, Settings | Click → route change |
| Repo selector | List from `/api/apps/github-collab/repos` | Dropdown → sets active repo context |
| Sync badge | Sync status from `/api/apps/github-collab/repos/:id/sync` | Click → navigates to sync details |

**Layout**: Horizontal bar, border-bottom, `background: var(--bg)`. Tabs use underline active indicator (2px `var(--green)` bottom border).

### 5.2 Overview Page

**Layout**: Single column, scrollable, `padding: 28px 32px`.

| Section | Data Source | Update |
|---------|-------------|--------|
| Stat cards (4-column grid) | `/api/apps/github-collab/repos/:id/stats` | Poll 30s |
| Sync status card | `/api/apps/github-collab/repos/:id/sync` | Poll 15s |
| Recent activity feed | SPARQL query on github-collab paranet | Poll 30s |
| Quick actions | Static | — |

**Stat cards**: Files indexed, Code entities, Triples in graph, Active agents. Each uses `.stat-card` pattern with accent bar.

### 5.3 Graph Explorer Page

**Layout**: Three-panel — sidebar (240px) | canvas (fluid) | detail panel (300px, conditional).

| Panel | Content | Data Source |
|-------|---------|-------------|
| Sidebar | Branch selector, entity type checkboxes, predicate chips, search input, legend | Local state + paranet query |
| Canvas | `<RdfGraph>` with ViewConfig | SPARQL CONSTRUCT on repo paranet |
| Detail | Selected node properties, relationships, actions | Model lookup from viz instance |

**SPARQL query pattern**:
```sparql
CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s ?p ?o .
  ?s a ?type .
  FILTER(?type IN (ghc:File, ghc:Function, ghc:Class, ghc:Interface, ghc:Import))
}
LIMIT 10000
```

**Interaction**: Click node → detail panel slides in. Double-click → `viz.focus(nodeId, 2)`. Search → `viz.highlightNodes(matchingIds)`. Entity type toggle → re-runs filtered CONSTRUCT.

### 5.4 Branch Diff Page

**Layout**: Toolbar (branch pickers + summary) above full-width graph canvas.

| Element | Data Source |
|---------|-------------|
| Branch picker dropdowns | `/api/apps/github-collab/repos/:id/branches` |
| Diff summary bar | SPARQL comparing branch graphs |
| Diff graph | Two CONSTRUCT queries (base + compare), diff computed client-side |
| Entity change list | Derived from diff computation |

### 5.5 PR/Issue Page

**Layout**: Sub-tabs (PRs / Issues / Commits) above a list → detail split view.

| Sub-tab | List Data | Detail Data |
|---------|-----------|-------------|
| PRs | `/api/apps/github-collab/repos/:id/prs` | SPARQL for PR impact graph |
| Issues | `/api/apps/github-collab/repos/:id/issues` | SPARQL for related entities |
| Commits | `/api/apps/github-collab/repos/:id/commits` | SPARQL for commit change set |

**PR detail** uses `<RdfGraph>` with the PR node as `focal` entity, connected to changed files and affected code entities.

### 5.6 Agents Page

**Layout**: Grid — agent roster (top) + task board (middle) + activity log (bottom).

| Section | Data Source | Update |
|---------|-------------|--------|
| Agent roster | SPARQL: agents with active sessions on this paranet | Poll 10s |
| Task board | SPARQL: tasks by status | Poll 15s |
| File claims | SPARQL: file claim assertions | Poll 15s |
| Activity log | SPARQL: recent agent actions, ordered by time | Poll 10s |

### 5.7 Settings Page

**Layout**: Single column with card sections, matching `.settings-grid` pattern.

| Card | Content |
|------|---------|
| GitHub Auth | Token status, update/revoke, test connection |
| Sync Configuration | Schedule, branch selection, file filters |
| Privacy | Paranet privacy toggle, publish/unpublish |
| Danger Zone | Remove repo (deletes paranet data), disconnect GitHub |

---

## 6. Progressive Loading Strategy

For repositories with 100k+ files, direct full-graph loading is impractical. The strategy uses tiered loading with progressive enhancement.

### 6.1 Ingestion Tiers

| Tier | Scope | When |
|------|-------|------|
| T0: Structure | Directory tree, file metadata (path, size, language) | Initial ingest |
| T1: Declarations | Exported functions, classes, interfaces, types | Initial ingest (parse-only, no AST) |
| T2: Dependencies | Import/require edges between files | Initial ingest |
| T3: Detailed AST | Function bodies, call graphs, variable references | On-demand per file/directory |
| T4: Semantic | Comments, docstrings, complexity metrics | On-demand or background |

### 6.2 Graph Loading Strategy

```
User opens Graph Explorer
  │
  ├─ Default: Load T0+T1 summary (package-level clusters)
  │   CONSTRUCT { ?s ?p ?o } WHERE {
  │     ?s a ghc:Package ; ?p ?o .
  │   } LIMIT 5000
  │
  ├─ User clicks package → Load T1+T2 for that package
  │   CONSTRUCT { ?s ?p ?o } WHERE {
  │     ?s ghc:containedIn <pkg:URI> ; ?p ?o .
  │   } LIMIT 10000
  │
  ├─ User clicks file → Load T2+T3 for that file
  │   CONSTRUCT { ?s ?p ?o } WHERE {
  │     { ?s ghc:definedIn <file:URI> ; ?p ?o }
  │     UNION
  │     { <file:URI> ?p ?o . BIND(<file:URI> AS ?s) }
  │   }
  │
  └─ User searches → Server-side SPARQL with text filter
      SELECT ?entity ?label ?type WHERE {
        ?entity rdfs:label ?label .
        FILTER(CONTAINS(LCASE(?label), "searchterm"))
      } LIMIT 50
```

### 6.3 Viewport-Aware Loading

- Initial load: package-level overview (cluster nodes representing directories)
- Zoom in: expand clusters to show files
- Zoom further: expand files to show contained entities
- `viz.on('node:click')` triggers on-demand loading of node neighborhood

### 6.4 Ingestion Pagination

Large repos are ingested in batches:
- API accepts `cursor` parameter for pagination
- Each batch: 500 files parsed → triples published
- Progress reported via SSE stream to UI
- Background worker continues after initial page shown

---

## 7. Real-Time Collaboration Activity Display

### 7.1 Activity Stream Protocol

Activity events are published to the DKG graph as `ghc:Activity` entities:

```turtle
<urn:ghc:activity:UUID> a ghc:Activity ;
  ghc:agent "agent-name" ;
  ghc:action "file_claim" ;
  ghc:target <file:URI> ;
  ghc:timestamp "2026-03-24T14:35:00Z"^^xsd:dateTime ;
  ghc:repo <did:dkg:github:owner/repo> .
```

### 7.2 Polling Strategy

The UI polls for activity using a watermark pattern:

1. Initial load: `SELECT ?activity ... ORDER BY DESC(?ts) LIMIT 50`
2. Subsequent polls (every 10s): `SELECT ?activity ... FILTER(?ts > "lastSeenTs")`
3. New activities prepended to feed with fade-in animation

### 7.3 Activity Feed Component

Each activity row shows:
- Timestamp (relative: "2m ago")
- Agent name + status dot (online = green)
- Action verb + target entity
- Clickable target → navigates to entity in graph

### 7.4 Presence Indicators

Agent presence is shown via:
- Agent roster with online/offline status (polled from agent sessions)
- File claim indicators in graph (nodes with agent border color)
- Graph overlay: agent cursors shown as colored dots on nodes they're currently viewing (if supported by the collaboration protocol)

---

## 8. Graph Visualization Configurations (ViewConfig)

### 8.1 Code Structure View (default)

```typescript
const codeStructureView: ViewConfig = {
  name: 'Code Structure',
  palette: 'dark',
  nodeTypes: {
    'ghc:File':       { color: '#60a5fa', shape: 'hexagon', sizeMultiplier: 1.2 },
    'ghc:Function':   { color: '#4ade80', shape: 'circle' },
    'ghc:Class':      { color: '#a78bfa', shape: 'hexagon', sizeMultiplier: 1.3 },
    'ghc:Interface':  { color: '#f472b6', shape: 'hexagon' },
    'ghc:Package':    { color: '#fbbf24', shape: 'hexagon', sizeMultiplier: 1.5 },
    'ghc:Import':     { color: '#94a3b8', shape: 'circle', sizeMultiplier: 0.6 },
    'ghc:Variable':   { color: '#22d3ee', shape: 'circle', sizeMultiplier: 0.5 },
  },
  sizeBy: {
    property: 'lineCount',
    scale: 'log',
  },
  tooltip: {
    titleProperties: ['name', 'label'],
    subtitleTemplate: '{type} · {path}',
    fields: [
      { label: 'File', property: 'path' },
      { label: 'Line', property: 'startLine', format: 'number' },
      { label: 'Lines', property: 'lineCount', format: 'number' },
    ],
  },
  animation: {
    fadeIn: true,
    linkParticles: false,
    drift: false,
  },
};
```

### 8.2 Dependency Flow View

```typescript
const dependencyFlowView: ViewConfig = {
  name: 'Dependency Flow',
  palette: 'midnight',
  nodeTypes: {
    'ghc:File':    { color: '#60a5fa', shape: 'hexagon' },
    'ghc:Package': { color: '#fbbf24', shape: 'hexagon', sizeMultiplier: 2.0 },
  },
  circleTypes: ['ghc:Function', 'ghc:Class', 'ghc:Interface'],
  highlight: {
    property: 'importCount',
    source: 'self',
    threshold: 10,
    color: '#f87171',
    topN: 20,
    sizeMin: 1.0,
    sizeMax: 3.0,
  },
  animation: {
    fadeIn: true,
    linkParticles: true,
    linkParticleCount: 1,
    linkParticleSpeed: 0.004,
    linkParticleColor: 'rgba(96, 165, 250, 0.5)',
    linkParticleWidth: 1.0,
  },
  tooltip: {
    titleProperties: ['name'],
    subtitleTemplate: '{type}',
    fields: [
      { label: 'Imports', property: 'importCount', format: 'number' },
      { label: 'Imported by', property: 'importedByCount', format: 'number' },
    ],
  },
};
```

### 8.3 PR Impact View

```typescript
const prImpactView = (prUri: string): ViewConfig => ({
  name: 'PR Impact',
  palette: 'dark',
  focal: {
    uri: prUri,
    sizeMultiplier: 2.0,
  },
  nodeTypes: {
    'ghc:PullRequest': { color: '#4ade80', shape: 'hexagon', sizeMultiplier: 2.0 },
    'ghc:File':        { color: '#60a5fa', shape: 'hexagon' },
    'ghc:Function':    { color: '#a78bfa', shape: 'circle' },
    'ghc:Issue':       { color: '#fbbf24', shape: 'hexagon' },
    'ghc:Commit':      { color: '#94a3b8', shape: 'circle', sizeMultiplier: 0.8 },
    'ghc:Review':      { color: '#22d3ee', shape: 'circle' },
  },
  highlight: {
    property: 'changeType',
    source: 'self',
    threshold: 0,
    color: '#f87171',
    topN: 50,
    sizeMultiplier: 1.5,
  },
  animation: {
    fadeIn: true,
    linkParticles: true,
    linkParticleCount: 1,
    linkParticleSpeed: 0.006,
    linkParticleColor: 'rgba(74, 222, 128, 0.5)',
    linkParticleWidth: 1.2,
  },
  tooltip: {
    titleProperties: ['title', 'name'],
    subtitleTemplate: '{type} · {author}',
    fields: [
      { label: 'Status', property: 'status' },
      { label: 'Changed', property: 'changeType' },
    ],
  },
});
```

### 8.4 Branch Diff View

```typescript
const branchDiffView: ViewConfig = {
  name: 'Branch Diff',
  palette: 'dark',
  nodeTypes: {
    'ghc:AddedEntity':    { color: '#4ade80', shape: 'hexagon' },
    'ghc:ModifiedEntity': { color: '#fbbf24', shape: 'hexagon' },
    'ghc:RemovedEntity':  { color: '#f87171', shape: 'hexagon' },
    'ghc:UnchangedEntity':{ color: '#475569', shape: 'circle', sizeMultiplier: 0.7 },
  },
  animation: {
    fadeIn: true,
    riskPulse: true,  // pulse added entities
  },
  tooltip: {
    titleProperties: ['name'],
    subtitleTemplate: '{changeType} in {branch}',
    fields: [
      { label: 'Change', property: 'changeType' },
      { label: 'File', property: 'path' },
    ],
  },
};
```

### 8.5 Agent Activity View

```typescript
const agentActivityView: ViewConfig = {
  name: 'Agent Activity',
  palette: 'cyberpunk',
  nodeTypes: {
    'ghc:Agent':    { color: '#4ade80', shape: 'hexagon', sizeMultiplier: 1.5 },
    'ghc:Task':     { color: '#fbbf24', shape: 'hexagon' },
    'ghc:File':     { color: '#60a5fa', shape: 'circle' },
    'ghc:Activity': { color: '#a78bfa', shape: 'circle', sizeMultiplier: 0.6 },
  },
  temporal: {
    enabled: true,
    dateProperty: 'timestamp',
    playbackSpeed: 2000,
  },
  animation: {
    fadeIn: true,
    linkParticles: true,
    linkParticleCount: 2,
    linkParticleSpeed: 0.008,
    linkParticleColor: 'rgba(74, 222, 128, 0.6)',
    linkParticleWidth: 1.5,
    drift: true,
    driftAlpha: 0.005,
  },
};
```

---

## 9. Agent API Specification

Agents interact with the GitHub Collab app programmatically via both HTTP API and DKG graph queries.

### 9.1 HTTP API Endpoints

All endpoints under `/api/apps/github-collab/`.

#### Repository Management
```
GET    /repos                          → { repos: RepoSummary[] }
POST   /repos                          → { repo: RepoDetail }
         body: { url, token, branches[], filters, schedule, privacy }
DELETE /repos/:id                      → { ok: boolean }
GET    /repos/:id                      → RepoDetail
GET    /repos/:id/stats                → { files, entities, triples, agents }
```

#### Sync
```
POST   /repos/:id/sync                → { jobId: string }
GET    /repos/:id/sync                → SyncStatus
GET    /repos/:id/sync/history        → { syncs: SyncRecord[] }
```

#### Branches
```
GET    /repos/:id/branches            → { branches: Branch[] }
GET    /repos/:id/branches/:name      → BranchDetail
GET    /repos/:id/diff?base=X&compare=Y → DiffResult
```

#### PRs and Issues
```
GET    /repos/:id/prs                  → { prs: PullRequest[] }
GET    /repos/:id/prs/:number          → PrDetail
GET    /repos/:id/issues               → { issues: Issue[] }
GET    /repos/:id/issues/:number       → IssueDetail
GET    /repos/:id/commits?branch=X&limit=N → { commits: Commit[] }
```

#### Agent Coordination
```
POST   /repos/:id/claims              → { claim: FileClaim }
         body: { file: string, agent: string }
DELETE /repos/:id/claims/:file        → { ok: boolean }
GET    /repos/:id/claims              → { claims: FileClaim[] }
GET    /repos/:id/agents              → { agents: AgentInfo[] }
GET    /repos/:id/tasks               → { tasks: Task[] }
POST   /repos/:id/tasks               → { task: Task }
         body: { description, assignee?, status? }
PUT    /repos/:id/tasks/:id           → { task: Task }
         body: { status?, assignee? }
```

#### Activity
```
GET    /repos/:id/activity?since=ISO&limit=N → { activities: Activity[] }
```

### 9.2 DKG Graph Queries (SPARQL)

Agents can query the code knowledge graph directly via the node's SPARQL endpoint.

**Find all functions in a file**:
```sparql
SELECT ?func ?name ?startLine WHERE {
  ?func a ghc:Function ;
        ghc:definedIn <file:URI> ;
        ghc:name ?name .
  OPTIONAL { ?func ghc:startLine ?startLine }
}
ORDER BY ?startLine
```

**Find what imports a module**:
```sparql
SELECT ?importer ?importerPath WHERE {
  ?importer ghc:imports <file:URI> ;
            ghc:path ?importerPath .
}
```

**Find unclaimed files in a directory**:
```sparql
SELECT ?file ?path WHERE {
  ?file a ghc:File ;
        ghc:path ?path .
  FILTER(STRSTARTS(?path, "src/api/"))
  FILTER NOT EXISTS {
    ?claim ghc:claimedFile ?file ;
           ghc:claimStatus "active" .
  }
}
```

**Find PR impact (affected entities)**:
```sparql
SELECT ?entity ?type ?name WHERE {
  <pr:URI> ghc:modifiesFile ?file .
  ?entity ghc:definedIn ?file ;
          a ?type ;
          ghc:name ?name .
}
```

### 9.3 Graph Mutations (Publish)

Agents publish knowledge via the DKG publish API:

**Claim a file**:
```json
{
  "paranetId": "github:owner/repo",
  "quads": [
    { "subject": "urn:ghc:claim:UUID", "predicate": "rdf:type", "object": "ghc:FileClaim" },
    { "subject": "urn:ghc:claim:UUID", "predicate": "ghc:claimedFile", "object": "file:src/auth.ts" },
    { "subject": "urn:ghc:claim:UUID", "predicate": "ghc:claimedBy", "object": "agent:claude-code-1" },
    { "subject": "urn:ghc:claim:UUID", "predicate": "ghc:claimStatus", "object": "\"active\"" },
    { "subject": "urn:ghc:claim:UUID", "predicate": "ghc:timestamp", "object": "\"2026-03-24T14:35:00Z\"^^xsd:dateTime" }
  ]
}
```

**Publish analysis result**:
```json
{
  "paranetId": "github:owner/repo",
  "quads": [
    { "subject": "urn:ghc:analysis:UUID", "predicate": "rdf:type", "object": "ghc:Analysis" },
    { "subject": "urn:ghc:analysis:UUID", "predicate": "ghc:analyzedEntity", "object": "file:src/auth.ts" },
    { "subject": "urn:ghc:analysis:UUID", "predicate": "ghc:finding", "object": "\"Missing error handling in login flow\"" },
    { "subject": "urn:ghc:analysis:UUID", "predicate": "ghc:agent", "object": "agent:claude-code-1" },
    { "subject": "urn:ghc:analysis:UUID", "predicate": "ghc:timestamp", "object": "\"2026-03-24T14:35:00Z\"^^xsd:dateTime" }
  ]
}
```

---

## 10. Responsive Layout

### Breakpoints

| Width | Layout Adaptation |
|-------|-------------------|
| >= 1180px | Full three-panel layout (sidebar + canvas + detail) |
| 900-1179px | Two-panel (sidebar collapses to icons, detail becomes bottom sheet) |
| < 900px | Single-panel with tab switching between sidebar/canvas/detail |

### Graph Canvas Sizing
- Minimum: 400x300px
- Canvas uses `ResizeObserver` (handled by graph-viz internally)
- On narrow layouts, graph takes full width with overlay controls

---

## 11. Error States

| Scenario | Display |
|----------|---------|
| GitHub auth failed | Red banner with retry button in auth step |
| Sync failed | Amber status badge + error detail in sync history |
| SPARQL query timeout | "Graph too large" message with suggestion to add filters |
| No repos configured | Redirect to onboarding page |
| Agent offline | Gray status dot, last-seen timestamp |
| Network error | Toast notification + retry action |
| Empty graph | Empty state illustration + "Start by ingesting a repository" |

---

## 12. Accessibility

- All interactive elements: `min-height: 44px` (matching DKG node UI pattern)
- Focus-visible outlines: `outline: 2px solid rgba(74,222,128,.5)`
- Graph canvas: keyboard navigation (Tab through nodes, Enter to select, Escape to deselect)
- Screen reader: ARIA labels on controls, graph summary text for non-visual users
- Color: all status indicators use shape/icon in addition to color (not color-only)
- Motion: respect `prefers-reduced-motion` — disable graph animations and particles
