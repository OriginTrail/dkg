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
- **Privacy level**: Radio group with descriptions
  - `workspace_only` — "Local Only: data stays on this node. Not visible to other DKG nodes." (default)
  - `paranet_shared` — "Shared: data is published to a paranet. Nodes that subscribe can query it."
  - For private repos, show warning: "This is a private repository. Selecting 'Shared' will make PR titles, issue descriptions, and code references visible to collaborating nodes."
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

**Collaborator onboarding (receiving side)**:
- Collaborator receives an invitation via P2P (GossipSub `node:invited` message) or enters a paranet ID manually
- Accept/Decline dialog: "Node {name} invited you to collaborate on {owner}/{repo}. Accept to subscribe and receive PR/issue data."
- On accept: auto-subscribe to paranet, sync existing data from peers
- Repo appears in collaborator's Overview with "Collaborator" role badge
- Collaborators can browse graph, view PRs, and participate in reviews
- Collaborators cannot trigger GitHub sync (no token required or stored)
- Access can be revoked by either party (unsubscribe from paranet)

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

### 5.1 Top Bar (persistent) — CRITICAL: Requires Implementation

| Element | Data | Interaction |
|---------|------|-------------|
| Tab navigation | Static labels: Overview, Graph, PRs, Collaboration, Settings | Click → route change |
| **Repo selector** | List from `GET /status` → `repos[].repoKey` | Dropdown → sets active repo context in `RepoContext` |
| Sync badge | Sync status per selected repo | Click → navigates to sync details |

**Repo selector details:**
- Populated from `GET /status` → shows `repoKey` with sync status dot (green/amber/red)
- "All Repositories" option at top (Overview and PRs only — Graph Explorer requires specific repo)
- "Add Repository" option at bottom → navigates to Settings
- If no repos configured, show onboarding CTA instead of dropdown
- Each entry shows: `{owner}/{repo}` with privacy badge (lock or globe icon) and sync status dot
- Selected repo stored in React context, consumed by all pages

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

---

## 13. UX Reassessment (2026-03-25)

This section documents a thorough UX review focused on privacy, multi-repo management, workspace separation, and collaboration flows. It identifies gaps between the spec and the current implementation, and specifies improvements.

### 13.1 Privacy Model — Gaps & Improvements

**Gap 1: Privacy level is invisible in the UI.**
The spec defines `workspace_only` vs `paranet_shared` privacy levels (Section 3.1, Step 3), but neither the OverviewPage nor the SettingsPage exposes or displays this setting. The `POST /config/repo` API accepts a `paranetId` but not a `privacyLevel` field.

**Improvement — Privacy Badge on Every Repo:**
Each repo row (in Overview and Settings tables) must show a privacy badge:
- `workspace_only` — lock icon, label "Local Only", tooltip: "Data stays on this node. Not shared with other nodes."
- `paranet_shared` — globe icon, label "Shared Paranet", tooltip: "Data is published to a paranet. Collaborators who subscribe can see it."

**Gap 2: No visibility into who can see data.**
The Agents/Collaboration page is a placeholder. There is no way for users to see which nodes are subscribed to a repo's paranet, or what data is visible to collaborators vs. what stays local.

**Improvement — Data Visibility Panel (Settings page, per repo):**
Add a "Data Visibility" section per repo in Settings:
- Shows current privacy level with option to change it
- Lists which node peers are subscribed to this paranet (if `paranet_shared`)
- Shows counts: "X triples in workspace (local only)" vs "Y triples in shared paranet"
- Warning when switching from `workspace_only` to `paranet_shared`: "This will make existing workspace data visible to collaborators who subscribe."
- Warning when switching from `paranet_shared` to `workspace_only`: "Existing enshrined data cannot be retracted. New data will remain local."

**Gap 3: GitHub PAT handling is adequate but the UX can improve.**
The token is sent via POST and stored server-side (correct). But the Settings page shows the token input as a password field with no indication of whether a token is already saved. After page reload, the input is blank even if a token exists server-side.

**Improvement — Token Status Indicator:**
- If a token is configured for a repo, show "Token configured" with a checkmark, the authenticated username, and a "Revoke / Replace" button
- Only show the token input when adding a new repo or replacing an existing token
- Never echo the token back to the UI — only show metadata (username, scopes, expiry if available)

**Gap 4: Private repos vs public repos are not distinguished.**
Users need to know whether their private repo data is safe. The onboarding flow mentions a lock icon for private repos (Section 3.1, Step 1), but there is no explicit statement about what happens to private repo data.

**Improvement — Private Repo Data Notice:**
During onboarding for private repos, display an explicit notice:
> "This is a private repository. Data synced from it (PRs, issues, code references) will be stored on your local DKG node. If you select 'Shared Paranet', this data will be visible to other nodes that subscribe. If you select 'Local Only', it stays on this node."

### 13.2 Multi-Repo Management — Gaps & Improvements

**Gap 1: No global repo selector in the top bar.**
The spec (Section 5.1) defines a `<RepoSelector>` in the TopBar, but the implementation (`AppShell.tsx`) has no repo selector — just static tab navigation. This means every page that needs repo context (PRs, Graph Explorer, Sync) forces users to manually type the `owner/repo` string. This is a critical usability gap.

**Improvement — Global Repo Selector:**
Add a `<RepoSelector>` dropdown in the AppShell header, between the title and the tab navigation:
- Populated from `GET /status` → `repos[].repoKey`
- Selected repo stored in React context (`RepoContext`)
- All pages consume the selected repo automatically — no more manual text inputs
- Shows sync status dot per repo (green=idle, amber=syncing, red=error)
- "Add Repository" option at the bottom opens Settings
- If no repos configured, show onboarding CTA instead of dropdown

**Gap 2: Adding a repo is too minimal.**
The SettingsPage has bare owner/repo text inputs with no validation, no URL parsing, no repo preview, and no configuration options (branches, privacy, sync schedule, file filters). This diverges significantly from the spec's onboarding flow (Section 3.1).

**Improvement — Repo Addition Wizard:**
Replace the bare inputs with a multi-step form matching Section 3.1:
1. URL or owner/repo input with validation and repo preview
2. Token input with test (or use existing token)
3. Configuration: privacy level, sync schedule, sync scope checkboxes
4. Confirmation and start initial sync

At minimum for the first implementation pass, the "Add Repository" form should include:
- Privacy level radio: `workspace_only` / `paranet_shared`
- Sync schedule dropdown: Manual / 15min / 1hr / 6hr
- Sync scope checkboxes: PRs, Issues, Reviews, Commits

**Gap 3: Removing a repo has no confirmation.**
The "Remove" button calls `removeRepo()` immediately with no confirmation dialog.

**Improvement:**
Show a confirmation dialog: "Remove {owner}/{repo}? This will delete the local paranet and all synced data. Enshrined data on-chain cannot be removed." With "Cancel" and "Remove Repository" (destructive) buttons.

**Gap 4: Per-repo settings not scoped.**
There is no way to view or edit settings for an individual repo after it is added (change sync schedule, update token, change privacy, manage branches).

**Improvement — Per-Repo Settings Expansion:**
Each repo row in the Settings table should be expandable (or link to a repo detail page) showing:
- Current configuration (privacy, sync schedule, scope, branches)
- Token status (authenticated as X, scopes)
- Sync history (last 10 syncs with status)
- "Edit" for each setting, "Remove" in danger zone

### 13.3 Collaboration & Invitations — Gaps & Improvements

**Gap 1: Agents page is a placeholder.**
The `AgentsPage.tsx` renders only static placeholder text. None of the specified collaboration features (agent roster, task board, file claims, activity log) exist in the implementation.

**Gap 2: No invitation flow exists.**
The spec mentions "Invite" buttons and peer ID inputs (Section 3.4), but there are no API endpoints for invitations and no UI for sending or receiving them.

**Gap 3: No collaborator management UI.**
The architecture doc defines a `GET /collaborators` endpoint (Section 4.5), but this endpoint does not exist in `handler.ts`.

**Improvement — Collaboration Tab Redesign:**
Rename "Agents" tab to "Collaboration" and implement in phases:

**Phase 1 (MVP):**
- Collaborator list: Query subscribed peers from the paranet, show peerId (truncated), node name, online/offline status, last seen
- Invite flow: Input for peer ID + "Invite to {repo}" button. Sends a GossipSub `node:invited` message. Show pending/accepted/rejected status.
- Activity log: SPARQL-queried list of recent sync events, review actions, and node join/leave

**Phase 2:**
- Agent roster with current tasks (from `ghc:Agent` entities in the graph)
- Task board (Kanban: claimed/active/done)
- File claim table

**Collaborator's perspective (receiving an invitation):**
This is an entirely missing flow. When Node B receives an invitation via GossipSub, it needs:
- A notification in the DKG node UI (or within the GitHub Collab app if it's already installed)
- An "Accept / Decline" action
- On accept: auto-configure the repo (without needing a GitHub token — collaborators may be observers only)
- Clear indication of what access level they get: "You will receive PR and issue data from {owner}/{repo}. You can participate in reviews but cannot sync directly from GitHub."

### 13.4 Knowledge Graph & Workspace Storage — Gaps & Improvements

**Gap 1: Workspace vs enshrined distinction is invisible.**
The spec defines a clear data lifecycle (architecture doc Section 5.2): open PRs live in workspace, merged PRs get enshrined. But the UI provides no indication of whether data is in the workspace (ephemeral) or enshrined (permanent).

**Improvement — Data Lifecycle Indicators:**
- In the PR list, add a column or badge: "Workspace" (gray) vs "Enshrined" (green with chain icon)
- In the Graph Explorer, allow filtering by storage tier: "All" / "Workspace only" / "Enshrined only" (maps to `includeWorkspace` param)
- In PR detail view, show enshrinement status: "This PR was enshrined on {date}" with UAL link, or "This PR is in workspace (will be enshrined when merged)"

**Gap 2: "Enshrine" / "Workspace" / "Paranet" terminology is DKG-internal jargon.**
Users unfamiliar with DKG will not understand these terms.

**Improvement — Terminology Glossary & Contextual Help:**
Add a glossary accessible from the Settings page or a "?" icon:
- **Workspace**: Temporary storage on your node. Like a draft — data can be updated or deleted.
- **Enshrined**: Permanently recorded on the network with a cryptographic proof. Like a published record — cannot be modified.
- **Paranet**: A shared knowledge space. Nodes that subscribe to the same paranet can see and query the same data.
- **Knowledge Asset**: A self-contained unit of knowledge (e.g., one PR with all its reviews) stored as a verifiable graph.

Use friendlier labels in the UI where possible:
- "Workspace" -> "Draft" or "Staging"
- "Enshrined" -> "Published" or "Permanent"
- "Paranet" -> "Shared Space" (with "paranet" in parentheses for technical users)

### 13.5 Paranet Workspace Separation — Gaps & Improvements

**Gap 1: Multiple repos share the same UI with no scope separation.**
When a user has repos A and B configured, the Overview page lists both in a flat table. The Graph Explorer, PR page, and Agents page have no repo scoping — they either require manual text input or show data from all repos mixed together.

**Improvement — Repo-Scoped Everything:**
With the global `<RepoSelector>` (Section 13.2), every page is automatically scoped:
- Overview shows stats for the selected repo only
- Graph Explorer queries only the selected repo's paranet
- PRs page shows PRs from the selected repo
- Collaboration tab shows collaborators for the selected repo's paranet

The repo selector should visually show the paranet ID alongside the repo name to reinforce the 1:1 repo-paranet mapping:
```
[v] OriginTrail/dkg-v9
    Paranet: github-collab:OriginTrail/dkg-v9 | Shared | 3 collaborators
```

**Gap 2: No "All Repos" view.**
Sometimes users want a cross-repo overview.

**Improvement — "All Repositories" option in RepoSelector:**
When "All Repositories" is selected:
- Overview shows the repo table (current behavior)
- Graph Explorer is disabled (must select a specific repo)
- PRs page shows a combined list with repo column
- Collaboration shows all collaborators across all repos

**Gap 3: Graph Explorer has no paranet indicator.**
Users querying the graph cannot see which paranet/workspace their query is scoped to.

**Improvement:**
Show a banner in the Graph Explorer: "Querying: github-collab:{owner}/{repo} (workspace + enshrined)" or "Querying: enshrined only". This maps to the `includeWorkspace` toggle that should be exposed in the UI.

### 13.6 Missing Flows

**Missing Flow 1: Onboarding for collaborators (not repo owners).**
The current onboarding assumes the user is the repo owner adding their own repo with a GitHub token. A collaborator who receives an invitation has a completely different flow — they don't need a GitHub token, they just need to subscribe to the paranet.

**Collaborator Onboarding Flow:**
```
Receive invitation (via P2P or shared paranet ID)
  -> "Join Collaboration" button
  -> Auto-subscribe to paranet
  -> Sync existing data from peers
  -> Show repo in Overview with "Collaborator" role badge
  -> Can browse graph, view PRs, participate in reviews
  -> Cannot trigger GitHub sync (no token)
```

**Missing Flow 2: Review consensus UI.**
The API supports `POST /review/request` and `POST /review/submit` with consensus tracking, but there is no UI for:
- Viewing active review sessions
- Submitting a review decision
- Seeing consensus progress (2/3 approvals)
- Seeing the final enshrined review result

This should be part of the PR detail view:
- "Request Review" button → opens a dialog to select peer reviewers and required approvals
- Review status panel showing each reviewer's decision
- Consensus bar (e.g., "2 of 3 required approvals")
- "Enshrined" badge when consensus is reached and the review is published

**Missing Flow 3: Webhook setup guidance.**
The webhook endpoint exists (`POST /webhook`) but there is no UI guidance for setting up the GitHub webhook. Users need to know:
- The webhook URL to configure in GitHub
- Which events to select
- How to set a webhook secret
- How to verify it's working

**Improvement — Webhook Setup Helper (Settings page, per repo):**
A "Webhook Setup" card with:
- The webhook URL (copyable): `https://{node-host}/api/apps/github-collab/webhook`
- Checklist of events to enable
- Optional: webhook secret input (generates one or lets user paste one)
- "Test Webhook" button that sends a ping event
- Status indicator: "Webhook active" / "No webhook configured" / "Last webhook received: 5min ago"

**Missing Flow 4: Error recovery and sync failure handling.**
Section 11 defines error states, but the implementation has minimal error handling. The SettingsPage swallows errors silently (`catch(() => {})`). There is no retry mechanism for failed syncs.

**Improvement:**
- Failed syncs should show an error detail expandable with the failure message
- "Retry" button next to failed sync entries
- If GitHub API rate limit is hit, show remaining quota and reset time
- If the DKG agent is unavailable (503), show a clear "DKG node offline" banner with guidance

### 13.7 Security Concerns

**Concern 1: CORS is `Access-Control-Allow-Origin: *`.**
The API handler sets `*` for CORS. While the app runs in an iframe sandbox (origin `null`), this means any web page could call these endpoints if it knows the node's address.

**Recommendation:** Restrict CORS to the iframe origin or use a token-based auth check (which already exists via the Bearer token). Document that the Bearer token is the security boundary, not CORS.

**Concern 2: No rate limiting on the API.**
The `POST /auth/test` endpoint accepts any token and calls GitHub's API. This could be abused for token validation attacks.

**Recommendation:** Rate-limit sensitive endpoints (auth test, sync trigger) to prevent abuse. Even simple in-memory rate limiting (e.g., 10 requests per minute per endpoint) would suffice.

**Concern 3: SPARQL injection potential.**
The `POST /query` endpoint accepts raw SPARQL. While this queries a local store (not a remote database), malicious or malformed queries could cause DoS via expensive graph patterns.

**Recommendation:** Implement query complexity limits (max triples returned, timeout) and document that SPARQL queries are local-only (not a network-wide query).

### 13.8 Implementation Priority

Based on severity of gaps between spec and implementation:

| Priority | Item | Effort |
|----------|------|--------|
| **P0** | Global `<RepoSelector>` in AppShell + RepoContext | Medium |
| **P0** | Privacy level display (badges on repo rows) | Small |
| **P0** | Repo removal confirmation dialog | Small |
| **P1** | Settings: per-repo expandable detail (privacy, schedule, scope) | Medium |
| **P1** | Settings: token status indicator (not raw input) | Small |
| **P1** | PRs page: auto-scope to selected repo, enshrinement badge | Small |
| **P1** | Graph Explorer: paranet scope indicator + workspace toggle | Small |
| **P1** | Collaboration tab: collaborator list (from paranet subscribers) | Medium |
| **P2** | Onboarding wizard (multi-step repo addition) | Large |
| **P2** | Review consensus UI (in PR detail view) | Medium |
| **P2** | Webhook setup helper | Medium |
| **P2** | Invitation send/receive flow | Large |
| **P3** | Terminology glossary / contextual help | Small |
| **P3** | Activity log (SPARQL-based event feed) | Medium |
| **P3** | Cross-repo "All Repositories" view | Small |
