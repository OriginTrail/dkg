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

**Step 2: Authenticate GitHub (optional for public repos)**
- For public repos, show: "GitHub token is optional for public repositories. Without a token, API rate limits are lower (60 req/hr vs 5,000 req/hr). Add a token for faster syncing or to access private repos."
- Skip button: "Continue without token" (only for public repos)
- Input for GitHub Personal Access Token (PAT)
- Required scopes displayed: `repo` (for private repos), `read:org` (optional)
- "Test Connection" button validates token against GitHub API
- Success: shows green checkmark, authenticated username, token scopes
- Token stored server-side only (never in iframe storage)
- Option: "Use existing token" if previously configured

**Step 3: Configure Repository Settings**
- **Branch selection**: Multi-select of branches to track (default: main/master + open PR branches)
- **Privacy level**: Radio group with descriptions (default: `workspace_only`)
  - `workspace_only` — "Local Only: data stays on this node. Not visible to other DKG nodes." **(default, pre-selected)**
  - `paranet_shared` — "Shared: data is stored in a paranet workspace. You can invite other DKG V9 nodes to subscribe and query this data. See Section 14 for full details."
  - For private repos, show warning: "This is a private repository. Selecting 'Shared' will make PR titles, issue descriptions, and code references visible to collaborating nodes."
  - **IMPORTANT**: The default MUST be `workspace_only` (Local Only). Users must explicitly opt in to sharing.
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

#### 3.3.1 Branch Selection Model (addresses feedback #7)

The branch selector is the primary mechanism for scoping what the Graph Explorer and other views show. The design must serve both human users browsing interactively and AI agents querying programmatically.

**Design Decision**: A branch selector dropdown that defaults to the repository's default branch (usually `main` or `master`).

```
┌──────────────────────────────────────────────────┐
│  Branch: [main ▾]                                │
│          ┌────────────────────────┐              │
│          │ ● main (default)       │              │
│          │   feat/auth            │              │
│          │   feat/new-api         │              │
│          │   fix/login-timeout    │              │
│          │ ─────────────────────  │              │
│          │   All branches         │              │
│          └────────────────────────┘              │
└──────────────────────────────────────────────────┘
```

**Behavior**:
- **Default**: Shows the repo's default branch (from GitHub API `default_branch` field)
- **Single branch selected**: Graph Explorer shows entities that exist on that branch. PRs page filters to PRs targeting or originating from that branch.
- **"All branches" option**: Shows everything across all synced branches. Entities that exist on multiple branches appear once. Useful for getting a complete picture, but may be noisy for large repos.
- **Branch indicator**: The selected branch is shown persistently in the Graph Explorer toolbar so users always know their scope.

**Agent API**:
- Agents specify a branch via query parameter: `GET /repos/:id/graph?branch=feat/auth`
- Default: the repo's default branch (same as UI)
- `branch=*` returns all branches (equivalent to "All branches" in the UI)
- Agents can also specify branches in SPARQL queries via the `ghc:branch` predicate

**Why this design**:
- Defaulting to the main branch gives the most stable, useful view for both humans and agents
- A dropdown is simpler than showing all branches simultaneously (which creates visual noise)
- The "All branches" escape hatch exists for users who want the full picture
- Agents get the same scoping via API parameters, keeping the model consistent

#### 3.3.2 Branch Diff View

For comparing two branches, a separate diff mode is available:

```
┌──────────────────────────────────────────────────────────────┐
│                   BRANCH DIFF                                 │
│                                                              │
│  Base: [main ▾]  Compare: [feat/auth ▾]   [Diff Mode ▾]    │
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
- Manual "Sync Now" button (see interaction spec below)
- Sync history table (last 20 syncs)
- Pending changes feed (changes detected but not yet synced)

**"Sync Now" Button — Interaction Spec (addresses feedback #1, #2)**:

The "Sync Now" button MUST provide continuous feedback. A sync with no visible progress is indistinguishable from a broken sync.

1. **On click**: Button text changes to "Syncing..." with a spinner icon. Button is disabled to prevent double-clicks.
2. **Progress phases** (displayed inline below the button or in a progress panel):
   - Phase 1: "Connecting to GitHub..." (0-2s typically)
   - Phase 2: "Fetching PRs and issues..." with count: "Found 12 PRs, 34 issues"
   - Phase 3: "Fetching commits..." with count: "Found 156 commits on 3 branches"
   - Phase 4: "Building knowledge graph..." with triple count: "Created 2,847 triples"
   - Phase 5: "Sync complete" with summary: "+45 new, ~12 updated, -3 removed"
3. **On error**: Red error message with details. "Retry" button appears. Common errors:
   - "GitHub API rate limit exceeded. Resets at {time}."
   - "GitHub token expired or revoked. Update in Settings."
   - "Repository not found. Check the URL in Settings."
   - "Network error. Check your connection and try again."
4. **On empty result** (no changes found): Show "No changes since last sync ({time ago})" — this is success, not an error.
5. **Timeout**: If sync exceeds 5 minutes, show "Sync is taking longer than expected. Large repositories may take up to 15 minutes for initial sync." with a "Cancel" option.
6. **Technical**: Progress is delivered via SSE (Server-Sent Events) from `GET /repos/:id/sync/stream` or by polling `GET /repos/:id/sync` every 2 seconds during active sync.

### 3.6 Agent & Peer Coordination Flow (addresses feedback #9)

**Important terminology**: "Agents" in this context refers to **DKG V9 network peers** — other DKG nodes that have subscribed to the same paranet. These may be AI coding agents (like Claude Code or Cursor) running on other nodes, or human operators using their own DKG nodes. The tab should make this clear to avoid confusion.

**Tab header**: "Peers & Agents" (not just "Agents")
**Tab description** (shown as subtitle text below the tab header):
> "DKG V9 nodes subscribed to this repository's paranet. These peers can query the knowledge graph, participate in reviews, and coordinate work."

```
┌──────────────────────────────────────────────────────────────┐
│  PEERS & AGENTS                                              │
│  DKG V9 nodes subscribed to this repository's paranet.       │
│  These peers can query the knowledge graph, participate in   │
│  reviews, and coordinate work.                               │
│                                                              │
│  Connected Peers (3)                                         │
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
│   │   │   │   ├── <TabNav>                 # [Overview, Graph, PRs, Peers & Agents, Settings]
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
│   │   │       ├── <CollaborationPage>       # Collaboration — invitation, peers, coordination (see Section 16)
│   │   │       │   ├── <CollaborationHeader>    # Page title + subtitle
│   │   │       │   ├── <NoRepoSelected>         # Prompt to select repo
│   │   │       │   ├── <LocalOnlyBanner>        # State A: Local Only conversion prompt
│   │   │       │   │   └── <ConversionDialog>   # Modal for Local → Shared
│   │   │       │   ├── <SharedSpaceBanner>      # States B & C: paranet info + peer count
│   │   │       │   │   └── <CopyableId>         # ID with copy-to-clipboard button
│   │   │       │   ├── <InvitePeerSection>      # Peer ID input + invite button
│   │   │       │   │   └── <PeerIdInput>        # Validated peer ID input
│   │   │       │   ├── <CollaboratorList>        # Connected peers with status
│   │   │       │   │   └── <CollaboratorRow>    # Name, online/offline, current task
│   │   │       │   ├── <SentInvitationsList>    # Outgoing invitations with status
│   │   │       │   │   └── <InvitationRow>      # Peer ID, status, revoke
│   │   │       │   ├── <IncomingInvitationsList># Incoming invitations
│   │   │       │   │   └── <IncomingInvitationRow> # Accept/decline actions
│   │   │       │   └── <ActivityLog>            # Chronological event feed
│   │   │       │       └── <ActivityRow>        # Timestamp, agent, action
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
| Sync badge | Sync status per selected repo | Click → navigates to sync details. **Must show actual privacy level from repo config** (see feedback #6 fix in Section 14.3). |

**Repo selector details:**
- Populated from `GET /status` → shows `repoKey` with sync status dot (green/amber/red)
- "All Repositories" option at top (Overview and PRs only — Graph Explorer requires specific repo)
- "Add Repository" option at bottom → navigates to Settings
- If no repos configured, show onboarding CTA instead of dropdown
- Each entry shows: `{owner}/{repo}` with privacy badge and sync status dot
  - Privacy badge: lock icon + "Local" for `workspace_only`, globe icon + "Shared" for `paranet_shared`
  - The privacy badge MUST be visible both in the dropdown entries and on the selected repo display in the top bar
  - **Bug fix (feedback #6)**: The top-right `<SyncBadge>` must reflect the actual privacy level of the selected repo, NOT a hardcoded "shared" label. Read privacy from repo config via `GET /status`.
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

### 5.3 Graph Explorer Page (addresses feedback #7, #10)

**Layout**: Three-panel — sidebar (240px) | canvas (fluid) | detail panel (300px, conditional).

**Subtab descriptions** (shown as brief helper text under each subtab when the user first visits):
| Subtab | Purpose Description |
|--------|---------------------|
| Code Structure | "Browse files, functions, classes, and their relationships. The default view for understanding how the codebase is organized." |
| Dependencies | "Visualize import/require chains between files and packages. Find highly-connected modules and circular dependencies." |
| Branch Diff | "Compare two branches to see what entities were added, modified, or removed. Useful for reviewing PRs visually." |
| PR Impact | "See which code entities are affected by a pull request. Shows the blast radius of changes." |

These descriptions appear as muted subtitle text below each subtab label. After the user has visited a subtab, the description can be collapsed to save space (stored in local component state).

**Branch selector** (in sidebar, top position):
- Dropdown defaulting to the repo's default branch
- Options: all synced branches + "All branches" separator option
- Changing the branch re-runs the CONSTRUCT query scoped to that branch
- See Section 3.3.1 for full branch selection design

| Panel | Content | Data Source |
|-------|---------|-------------|
| Sidebar | **Branch selector** (top), entity type checkboxes, predicate chips, search input, legend | Local state + paranet query |
| Canvas | `<RdfGraph>` with ViewConfig | SPARQL CONSTRUCT on repo paranet, scoped to selected branch |
| Detail | Selected node properties, relationships, actions | Model lookup from viz instance |

**SPARQL query pattern** (branch-scoped):
```sparql
CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s ?p ?o .
  ?s a ?type .
  ?s ghc:branch ?branch .
  FILTER(?type IN (ghc:File, ghc:Function, ghc:Class, ghc:Interface, ghc:Import))
  FILTER(?branch = "main")
}
LIMIT 10000
```

When "All branches" is selected, the `ghc:branch` filter is omitted.

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

### 5.6 Peers & Agents Page (addresses feedback #9)

**Layout**: Grid — peer roster (top) + task board (middle) + activity log (bottom).

**Header**: "Peers & Agents" with description text: "DKG V9 nodes subscribed to this repository's paranet. These peers can query the knowledge graph, participate in reviews, and coordinate work."

**Empty state** (no peers connected): "No peers are connected to this paranet. To collaborate, share your paranet ID with other DKG V9 node operators, or invite them from the Settings page."

| Section | Data Source | Update |
|---------|-------------|--------|
| Peer roster | SPARQL: agents/nodes with active sessions on this paranet | Poll 10s |
| Task board | SPARQL: tasks by status | Poll 15s |
| File claims | SPARQL: file claim assertions | Poll 15s |
| Activity log | SPARQL: recent agent/peer actions, ordered by time | Poll 10s |

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

**Missing Flow 3: Webhook setup guidance (addresses feedback #5).**
The webhook endpoint exists (`POST /webhook`) but the UI shows "not configured" with no way to configure it and no explanation of what this means. This is confusing — users see a problem with no solution.

**Improvement — Webhook Setup Helper (Settings page, per repo):**

The webhook status indicator must NOT say "not configured" without providing actionable next steps. Replace with one of:

**State 1: No webhook (default for new repos)**
```
┌─────────────────────────────────────────────────────┐
│  Webhooks                                    [Setup] │
│                                                      │
│  Webhooks enable real-time sync — your graph updates │
│  instantly when PRs are opened, commits pushed, etc. │
│  Without webhooks, sync happens on your configured   │
│  schedule (or manually via "Sync Now").               │
│                                                      │
│  Status: Not configured (optional)                   │
│  Your repo will still sync on schedule.              │
└─────────────────────────────────────────────────────┘
```

**State 2: Setup instructions (after clicking "Setup")**
```
┌─────────────────────────────────────────────────────┐
│  Webhook Setup                                       │
│                                                      │
│  1. Go to your repo's Settings > Webhooks on GitHub  │
│  2. Click "Add webhook"                              │
│  3. Payload URL:                                     │
│     [https://{node}/api/apps/github-collab/webhook]  │
│     [Copy]                                           │
│  4. Content type: application/json                   │
│  5. Events to select:                                │
│     ☑ Pull requests                                  │
│     ☑ Pushes                                         │
│     ☑ Issues                                         │
│     ☑ Issue comments                                 │
│     ☑ Pull request reviews                           │
│  6. Click "Add webhook" on GitHub                    │
│                                                      │
│  [Test Connection]  [Done]                           │
└─────────────────────────────────────────────────────┘
```

**State 3: Webhook active**
```
│  Status: Active — last event received 5 min ago     │
│  [Reconfigure] [Remove]                              │
```

Key principle: "not configured" must always be accompanied by (a) what it means and (b) how to fix it or why it's okay to leave it.

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
| **P0** | Sync progress indicator ("Sync Now" feedback) | Medium |
| **P0** | Fix SyncBadge to show actual privacy, not hardcoded "shared" | Small |
| **P0** | Webhook status: actionable message, not bare "not configured" | Small |
| **P0** | GitHub token: mark as optional for public repos | Small |
| **P0** | Agents tab: rename to "Peers & Agents", add description | Small |
| **P0** | Graph Explorer: add subtab purpose descriptions | Small |
| **P0** | Branch selector in Graph Explorer (default to default branch) | Medium |
| **P3** | Terminology glossary / contextual help | Small |
| **P3** | Activity log (SPARQL-based event feed) | Medium |
| **P3** | Cross-repo "All Repositories" view | Small |

---

## 14. Shared Mode Definition (addresses feedback #4, #6)

This section defines exactly what "Shared" privacy mode means. This information must be surfaced in the UI wherever the privacy toggle appears (onboarding Step 3, Settings page, repo card badges).

### 14.1 What "Shared" Means

When a repository is imported with `paranet_shared` privacy:

1. **Data is stored in a paranet workspace.** A paranet is a scoped knowledge space on the DKG. The workspace is the mutable staging area within that paranet.

2. **Other DKG V9 nodes can be invited to subscribe.** The repo owner can invite specific peers by node ID. Only invited and subscribed nodes can see the data — it is NOT publicly visible on the network.

3. **Only invited/subscribed nodes see the data.** This is a permissioned collaboration model, not public broadcasting. Think "shared Google Doc with specific people invited" rather than "posted on a public website."

4. **The workspace is ephemeral (30-day TTL).** Workspace data expires after 30 days unless it is enshrined. This means open PR data, in-progress reviews, and draft analyses are temporary by design.

5. **Enshrinement happens on PR merge (or manual trigger).** When a PR is merged, the review data and final state are enshrined — made permanent on-chain with a cryptographic proof. Enshrined data cannot be modified or deleted.

### 14.2 UI Copy for Shared Mode

When the user selects "Shared" in the privacy radio group, display this expanded explanation:

> **Shared Paranet**
> Your repository data will be stored in a paranet workspace. You can invite other DKG V9 nodes to subscribe and collaborate.
>
> - Only nodes you invite can see the data
> - Workspace data expires after 30 days unless enshrined
> - PR data is automatically enshrined when PRs are merged
> - Enshrined data is permanent and cryptographically verifiable

### 14.3 Privacy Badge Spec

The privacy badge MUST appear in these locations:
- **Repo selector dropdown** (each entry): lock icon + "Local" or globe icon + "Shared"
- **Top bar** (selected repo): Same badge next to repo name
- **Overview page repo card**: Badge in header area
- **Settings page repo list**: Badge in each row

Badge visual spec:
```
Local Only:  [🔒 Local]     — gray background, lock icon, muted text
Shared:      [🌐 Shared]    — green border, globe icon, green text
```

### 14.4 What "Local Only" Means

For completeness, the `workspace_only` mode:
- Data stays entirely on this node
- No paranet is created
- No peers can see or query this data
- Data persists as long as the node is running (no TTL)
- Data is never enshrined (no on-chain footprint)

---

## 15. UX Feedback Changelog (2026-03-25)

Changes made to this spec based on user testing feedback:

| # | Feedback | Section Updated | Change Made |
|---|----------|-----------------|-------------|
| 1 | No sync progress indicator | 3.5 | Added detailed "Sync Now" interaction spec with 5 progress phases, error states, and empty-result handling |
| 2 | Sync didn't produce results | 3.5 | Added timeout messaging and empty-result UX ("No changes since last sync") |
| 3 | Default privacy is wrong | 3.1 Step 3 | Reinforced `workspace_only` as default with **IMPORTANT** callout |
| 4 | Privacy not shown in repo card | 14.3 | Added privacy badge spec with exact locations and visual treatment |
| 5 | Webhook says "not configured" | 13.6 | Redesigned webhook UX with 3 states: no webhook (with explanation), setup wizard, active |
| 6 | Top-right badge shows "shared" | 5.1 | Added bug fix note: SyncBadge must read actual privacy from config, not hardcode |
| 7 | Branch visualization unclear | 3.3 | Redesigned as branch selector dropdown defaulting to default branch, with "All branches" option and agent API |
| 8 | GitHub token requirement unclear | 3.1 Step 2 | Added "optional for public repos" messaging with rate limit explanation and skip button |
| 9 | Agents tab unclear | 3.6, 5.6 | Renamed to "Peers & Agents", added description clarifying these are DKG V9 network peers |
| 10 | Graph Explorer subtabs | 5.3 | Added purpose descriptions for each subtab (Code Structure, Dependencies, Branch Diff, PR Impact) |
| — | Shared mode undefined | 14 | Added full Section 14 defining Shared mode: paranet workspace, invitation-only, 30-day TTL, enshrinement |
| — | Agents & Collaboration tab redesign | 16 | Added full Section 16: invitation flow, collaboration states, peer management, API endpoints |

---

## 16. Agents & Collaboration Tab — Full Design (2026-03-25)

This section replaces the placeholder `<AgentsPage>` with a complete collaboration hub. The tab is the single surface for managing peer invitations, viewing collaborators, and coordinating agent work across DKG V9 nodes.

### 16.1 Tab Header & Identity

**Tab label in navigation**: "Collaboration" (renamed from "Agents")

**Rationale**: "Agents" suggests AI agents only. "Collaboration" correctly encompasses human operators, AI agents, and peer nodes. The tab subtitle provides the technical context.

**Page header**:
```
Collaboration
DKG V9 nodes subscribed to this repository's shared space (paranet).
These peers can query the knowledge graph, participate in reviews, and coordinate work.
```

### 16.2 Repo Context Requirement

The Collaboration tab is always scoped to the currently selected repo via `<RepoSelector>` in the AppShell header.

**No repo selected**:
```
┌──────────────────────────────────────────────────────────┐
│  Collaboration                                            │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │                                                    │    │
│  │    Select a repository from the dropdown above    │    │
│  │    to view collaboration settings.                │    │
│  │                                                    │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### 16.3 State A — Local Only Mode

When the selected repo has `privacyLevel: 'local'`, collaboration features are unavailable. The tab shows a conversion prompt.

```
┌──────────────────────────────────────────────────────────┐
│  Collaboration                                            │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  LOCAL ONLY MODE                                   │    │
│  │                                                    │    │
│  │  This repository is in Local Only mode. Data       │    │
│  │  stays on this node and is not shared with          │    │
│  │  other DKG V9 nodes.                               │    │
│  │                                                    │    │
│  │  To collaborate with other nodes, convert to       │    │
│  │  Shared mode. This will:                           │    │
│  │                                                    │    │
│  │  * Register a shared space (paranet) for this repo │    │
│  │  * Allow you to invite other DKG V9 nodes          │    │
│  │  * Enable collaborative reviews and coordination   │    │
│  │  * Workspace data expires after 30 days unless     │    │
│  │    enshrined (made permanent)                       │    │
│  │                                                    │    │
│  │  Your existing local data will remain accessible.  │    │
│  │  Only new data written after conversion will be    │    │
│  │  visible to invited collaborators.                 │    │
│  │                                                    │    │
│  │           [Share & Collaborate]                     │    │
│  │                                                    │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

**"Share & Collaborate" button** triggers the Local-to-Shared conversion flow (Section 16.7).

### 16.4 State B — Shared Mode, No Peers Yet

When the repo is shared but no peers are connected and no invitations are pending.

```
┌──────────────────────────────────────────────────────────┐
│  Collaboration                                            │
│  DKG V9 nodes subscribed to this repository's shared     │
│  space. These peers can query the knowledge graph,       │
│  participate in reviews, and coordinate work.            │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  SHARED SPACE                                      │    │
│  │                                                    │    │
│  │  Paranet ID:                                       │    │
│  │  ┌─────────────────────────────────────────┐       │    │
│  │  │ github-collab:owner/repo:a1b2c3d4       │ [Copy]│    │
│  │  └─────────────────────────────────────────┘       │    │
│  │                                                    │    │
│  │  Your Peer ID:                                     │    │
│  │  ┌─────────────────────────────────────────┐       │    │
│  │  │ 12D3KooWABCDEF...                       │ [Copy]│    │
│  │  └─────────────────────────────────────────┘       │    │
│  │                                                    │    │
│  │  Status: No peers connected                        │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  INVITE A PEER                                     │    │
│  │                                                    │    │
│  │  Enter a peer's DKG V9 node ID to invite them to  │    │
│  │  collaborate on this repository.                   │    │
│  │                                                    │    │
│  │  Peer ID:                                          │    │
│  │  [12D3KooW...                          ] [Invite]  │    │
│  │                                                    │    │
│  │  -- OR --                                          │    │
│  │                                                    │    │
│  │  Share your Paranet ID with collaborators so they  │    │
│  │  can join manually from their own node.            │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  PENDING INVITATIONS (INCOMING)                    │    │
│  │                                                    │    │
│  │  No incoming invitations.                          │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  ACTIVITY                                          │    │
│  │                                                    │    │
│  │  No activity yet. Invite peers to get started.     │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### 16.5 State C — Shared Mode, Active Collaboration

When the repo is shared and peers are connected.

```
┌──────────────────────────────────────────────────────────┐
│  Collaboration                                            │
│  DKG V9 nodes subscribed to this repository's shared     │
│  space.                                                  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  SHARED SPACE                     3 peers online   │    │
│  │                                                    │    │
│  │  Paranet: github-collab:owner/repo:a1b2c3d4 [Copy]│    │
│  │  Your Peer ID: 12D3KooWABCDEF...            [Copy]│    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  COLLABORATORS (3)                    [Invite Peer]│    │
│  │                                                    │    │
│  │  ● alice-node        Online     Last: just now     │    │
│  │    12D3KooW...abc    Reviewing PR #42              │    │
│  │                                                    │    │
│  │  ● bob-agent         Online     Last: 2 min ago    │    │
│  │    12D3KooW...def    Idle                          │    │
│  │                                                    │    │
│  │  ○ carol-node        Offline    Last: 3 hours ago  │    │
│  │    12D3KooW...ghi                                  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  SENT INVITATIONS (1 pending)                      │    │
│  │                                                    │    │
│  │  12D3KooW...xyz     Pending     Sent 10 min ago   │    │
│  │                                        [Revoke]    │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  PENDING INVITATIONS (INCOMING) (1)                │    │
│  │                                                    │    │
│  │  Node "dave-node" (12D3KooW...jkl) invited you    │    │
│  │  to collaborate on dave/other-repo                 │    │
│  │  Paranet: github-collab:dave/other-repo:f5e6d7c8  │    │
│  │  Received: 5 min ago                              │    │
│  │                                     [Accept] [X]   │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  ACTIVITY                                          │    │
│  │                                                    │    │
│  │  14:35  alice-node synced 42 triples               │    │
│  │  14:33  bob-agent  joined collaboration            │    │
│  │  14:30  alice-node submitted review on PR #42      │    │
│  │  14:28  You        sent invitation to 12D3K...xyz  │    │
│  │  14:15  carol-node went offline                    │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### 16.6 Invitation Flow — Sending

**Step 1**: User clicks "Invite Peer" or enters a peer ID in the invite input.

**Step 2**: Validation:
- Peer ID must match the DKG V9 peer ID format (`12D3KooW...`, base58-encoded libp2p peer ID)
- Cannot invite yourself (compare against own peer ID from `GET /info`)
- Cannot invite a peer who is already a collaborator or has a pending invitation

**Step 3**: On "Invite" click:
- UI shows inline spinner: "Sending invitation..."
- Backend sends a GossipSub `invite:sent` message on the paranet's app topic
- Additionally, if the peer is not yet subscribed to the topic, the invitation is also sent via a direct P2P message (unicast) using the peer ID
- Backend stores the invitation in memory with status `pending`

**Step 4**: UI updates:
- Invitation appears in "Sent Invitations" section with status "Pending"
- Toast notification: "Invitation sent to {peer ID}"

**Step 5**: When the peer accepts:
- A GossipSub `invite:accepted` message is received
- The invitation status changes from "Pending" to "Accepted"
- The peer appears in the "Collaborators" list
- Activity log entry: "{peer name} accepted your invitation"

**Step 6**: When the peer declines:
- A GossipSub `invite:declined` message is received
- The invitation status changes to "Declined"
- Activity log entry: "{peer name} declined your invitation"
- The invitation row is shown with muted styling and can be dismissed

### 16.7 Local to Shared Conversion Flow

When user clicks "Share & Collaborate" from the Local Only state:

**Step 1**: Confirmation dialog:
```
┌──────────────────────────────────────────────────┐
│  Convert to Shared Mode?                          │
│                                                  │
│  Repository: owner/repo                          │
│                                                  │
│  This will:                                      │
│  * Generate a unique shared space ID (paranet)   │
│  * Subscribe to the P2P collaboration network    │
│  * Allow you to invite other DKG V9 nodes        │
│                                                  │
│  Your existing local data remains on this node.  │
│  Only new data written after conversion will be  │
│  visible to invited collaborators.               │
│                                                  │
│  Note: Workspace data in shared mode expires     │
│  after 30 days unless enshrined (made permanent).│
│                                                  │
│              [Cancel]  [Convert to Shared]        │
└──────────────────────────────────────────────────┘
```

**Step 2**: On confirmation:
1. Generate 8-character random suffix (hex): `crypto.randomBytes(4).toString('hex')`
2. New paranet ID: `github-collab:{owner}/{repo}:{suffix}`
3. Call `POST /config/repo` with `privacyLevel: 'shared'` and the new `paranetId`
4. Backend creates paranet, subscribes to GossipSub, broadcasts `node:joined`

**Step 3**: Progress indicator:
```
Converting to Shared mode...
[============================] Creating shared space
[============================] Subscribing to network
[============================] Ready!
```

**Step 4**: Success state:
- Tab refreshes to State B (Shared, no peers)
- Toast: "Repository is now in Shared mode"
- Paranet ID displayed with Copy button
- RepoSelector badge updates from "Local" to "Shared"

### 16.8 Invitation Flow — Receiving

**Where invitations appear**:
1. **Tab badge**: The "Collaboration" tab in the nav bar shows a notification badge with the count of pending incoming invitations (e.g., "Collaboration (1)")
2. **Within the tab**: The "Pending Invitations (Incoming)" section lists all incoming invitations

**Invitation content**:
Each incoming invitation shows:
- Who invited: Node name + truncated peer ID
- Which repo: `{owner}/{repo}` (the repo name from the invitation message)
- Paranet ID: The full paranet ID for the shared space
- When: Relative timestamp ("5 min ago")
- Actions: [Accept] [Decline (X button)]

**Accept flow**:
1. User clicks "Accept"
2. Button shows spinner: "Joining..."
3. Backend:
   a. Calls `POST /config/repo` with the paranet ID from the invitation, `privacyLevel: 'shared'`, and no `githubToken` (collaborator role)
   b. Subscribes to GossipSub topic for that paranet
   c. Broadcasts `invite:accepted` message
   d. Begins syncing existing workspace data from peers
4. UI updates:
   - Invitation disappears from "Pending Invitations"
   - The repo appears in the user's `<RepoSelector>` dropdown with a "Collaborator" role badge
   - Tab badge count decrements
   - Toast: "Joined collaboration on {owner}/{repo}"

**Collaborator role**:
After accepting, the collaborator:
- Can browse the graph, view PRs/issues, and participate in reviews
- Cannot trigger GitHub sync (no GitHub token configured)
- Sees a "Collaborator" badge next to the repo name in the selector
- Can leave the collaboration at any time (unsubscribe from paranet)

**Decline flow**:
1. User clicks the X (decline) button
2. Backend sends `invite:declined` message
3. Invitation is removed from the list
4. No further action needed — declining is silent

### 16.9 Peer Discovery

**How does a user find another node's peer ID?**

There is no automatic discovery in the MVP. Peers share their IDs through out-of-band channels (Slack, email, etc.). The UI facilitates this with:

1. **"Your Peer ID" display with Copy button** — always visible in the Shared Space banner. Users copy this and share it with collaborators.

2. **"Paranet ID" display with Copy button** — collaborators can use this to join manually without needing an explicit invitation.

3. **Manual join** (future enhancement): A "Join Shared Space" input in the Collaboration tab where users can paste a paranet ID to subscribe directly. This bypasses the invitation flow — the user simply subscribes to the paranet. This is analogous to joining a Slack channel by URL.

**No QR codes or shareable links in MVP** — these add complexity without sufficient value when the primary audience is developers who are comfortable copying peer IDs. QR codes can be considered for a future mobile companion app.

### 16.10 Terminology

The tab uses user-friendly terminology with technical terms in parentheses where needed:

| User-facing term | Technical term | Used where |
|---|---|---|
| Shared Space | Paranet | Collaboration tab banner, conversion dialog |
| Peer | DKG V9 Node | Collaborator list, invitation form |
| Collaborator | Paranet subscriber | Collaborator list heading |
| Shared Space ID | Paranet ID | Copy-able identifier |
| Permanent record | Enshrined Knowledge Asset | Activity log (when data is enshrined) |

### 16.11 Component Hierarchy

```
<AgentsPage>  (renamed to CollaborationPage internally)
├── <CollaborationHeader>           # Page title + subtitle
├── <NoRepoSelected>                # Shown when no repo selected
├── <LocalOnlyBanner>               # State A: conversion prompt
│   └── <ConversionDialog>          # Modal for Local → Shared
├── <SharedSpaceBanner>             # States B & C: paranet info
│   ├── <CopyableId>               # Paranet ID with copy button
│   └── <CopyableId>               # Peer ID with copy button
├── <InvitePeerSection>             # Peer ID input + invite button
│   └── <PeerIdInput>              # Validated input for peer ID format
├── <CollaboratorList>              # Connected peers
│   └── <CollaboratorRow>          # Peer name, status, activity
├── <SentInvitationsList>           # Outgoing invitations
│   └── <InvitationRow>           # Peer ID, status, revoke action
├── <IncomingInvitationsList>       # Incoming invitations
│   └── <IncomingInvitationRow>    # Accept/decline actions
└── <ActivityLog>                   # Chronological event feed
    └── <ActivityRow>              # Timestamp, agent, action
```

### 16.12 API Endpoints for Invitation Flow

These endpoints are added under `/api/apps/github-collab`.

#### `GET /info`

Already exists. Returns `peerId` and `nodeName`. Used by the UI to display "Your Peer ID".

#### `POST /invite`

Send a collaboration invitation to a peer.

**Request:**
```json
{
  "peerId": "12D3KooWABCDEF...",
  "owner": "OriginTrail",
  "repo": "dkg-v9"
}
```

**Response:**
```json
{
  "ok": true,
  "invitationId": "inv-a1b2c3d4",
  "paranetId": "github-collab:OriginTrail/dkg-v9:e5f6g7h8",
  "status": "pending"
}
```

**Backend behavior:**
1. Looks up the repo config to get the paranet ID
2. Creates an invitation record in memory
3. Sends a GossipSub `invite:sent` message on the paranet topic
4. Sends a direct P2P message to the target peer ID (for peers not yet subscribed to the topic)

#### `GET /invitations`

List all invitations (sent and received).

**Query params:** `?repo=owner/repo` (optional, filters by repo)

**Response:**
```json
{
  "sent": [
    {
      "invitationId": "inv-a1b2c3d4",
      "peerId": "12D3KooW...",
      "repo": "OriginTrail/dkg-v9",
      "paranetId": "github-collab:OriginTrail/dkg-v9:e5f6g7h8",
      "status": "pending",
      "sentAt": 1711324800000
    }
  ],
  "received": [
    {
      "invitationId": "inv-x9y8z7w6",
      "fromPeerId": "12D3KooW...",
      "fromNodeName": "dave-node",
      "repo": "dave/other-repo",
      "paranetId": "github-collab:dave/other-repo:f5e6d7c8",
      "receivedAt": 1711325000000
    }
  ]
}
```

#### `POST /invitations/:id/accept`

Accept an incoming invitation.

**Response:**
```json
{
  "ok": true,
  "paranetId": "github-collab:dave/other-repo:f5e6d7c8",
  "repo": "dave/other-repo",
  "role": "collaborator"
}
```

**Backend behavior:**
1. Subscribes to the paranet's GossipSub topic
2. Adds the repo to the coordinator with `privacyLevel: 'shared'` and no GitHub token
3. Broadcasts `invite:accepted` message
4. Begins syncing workspace data from peers

#### `POST /invitations/:id/decline`

Decline an incoming invitation.

**Response:**
```json
{
  "ok": true
}
```

**Backend behavior:**
1. Sends `invite:declined` GossipSub message
2. Removes the invitation from memory

#### `DELETE /invitations/:id`

Revoke a sent invitation.

**Response:**
```json
{
  "ok": true
}
```

#### `GET /collaborators`

List peers subscribed to the selected repo's paranet. (Specified in architecture doc Section 4.5 but not yet implemented.)

**Query params:** `?repo=owner/repo`

**Response:**
```json
{
  "collaborators": [
    {
      "peerId": "12D3KooW...",
      "name": "alice-node",
      "connected": true,
      "lastSeen": 1711324800000,
      "currentTask": "Reviewing PR #42",
      "role": "owner"
    },
    {
      "peerId": "12D3KooW...",
      "name": "bob-agent",
      "connected": true,
      "lastSeen": 1711324780000,
      "currentTask": null,
      "role": "collaborator"
    }
  ]
}
```

**Data source:** The coordinator tracks peer presence via GossipSub `ping` messages (already implemented on a 60-second interval). The `node:joined` and `node:left` messages update the collaborator list.

#### `POST /convert-to-shared`

Convert a Local Only repo to Shared mode.

**Request:**
```json
{
  "owner": "OriginTrail",
  "repo": "dkg-v9"
}
```

**Response:**
```json
{
  "ok": true,
  "paranetId": "github-collab:OriginTrail/dkg-v9:a1b2c3d4",
  "previousParanetId": "github-collab:OriginTrail/dkg-v9"
}
```

**Backend behavior:**
1. Generate random 8-char hex suffix
2. Create new paranet with shared privacy
3. Subscribe to GossipSub
4. Broadcast `node:joined`
5. Update the repo config's `privacyLevel` to `'shared'`
6. Keep existing local data accessible (it remains in the old local paranet)

### 16.13 GossipSub Message Types — Additions

The following message types are added to `protocol.ts` for the invitation flow:

```typescript
export type MessageType =
  | 'node:joined'
  | 'node:left'
  | 'invite:sent'       // NEW: Invitation broadcast
  | 'invite:accepted'   // NEW: Invitation accepted
  | 'invite:declined'   // NEW: Invitation declined
  | 'review:requested'
  | 'review:submitted'
  | 'review:consensus'
  | 'sync:announce'
  | 'ping';

export interface InviteSentMessage extends BaseMessage {
  type: 'invite:sent';
  repo: string;
  targetPeerId: string;
  invitationId: string;
  nodeName?: string;     // Sender's node name for display
}

export interface InviteAcceptedMessage extends BaseMessage {
  type: 'invite:accepted';
  repo: string;
  invitationId: string;
  nodeName?: string;     // Acceptor's node name for display
}

export interface InviteDeclinedMessage extends BaseMessage {
  type: 'invite:declined';
  repo: string;
  invitationId: string;
}
```

### 16.14 Polling & Data Freshness

| Section | Data Source | Poll Interval |
|---------|-------------|---------------|
| Shared Space banner | `GET /info` (peer ID, node name) | Once on mount |
| Collaborator list | `GET /collaborators?repo=X` | 10 seconds |
| Sent invitations | `GET /invitations?repo=X` | 15 seconds |
| Incoming invitations | `GET /invitations` (no repo filter — incoming may be for any repo) | 10 seconds |
| Activity log | SPARQL query for recent activities | 15 seconds |

Incoming invitations poll at 10 seconds to ensure timely display of new invitations. The tab badge count is derived from this same poll.

### 16.15 Tab Badge for Incoming Invitations

The navigation tab "Collaboration" shows a badge count when there are pending incoming invitations.

**Implementation**: The `<AppShell>` component polls `GET /invitations` on a 30-second interval. If `received.length > 0`, the tab label renders as:

```tsx
<NavLink to="/collaboration">
  Collaboration {invitationCount > 0 && <span className="tab-badge">{invitationCount}</span>}
</NavLink>
```

**Badge styling**: Small circle, `background: var(--green)`, white text, positioned top-right of the tab label. Matches the standard notification badge pattern.

### 16.16 Edge Cases

**Peer invites you for a repo you already have locally:**
- The invitation shows the repo name. If you have the same `owner/repo` in Local Only mode, the Accept flow should offer: "You already have this repository in Local Only mode. Accept to join the shared collaboration space? Your local data will remain separate."
- On accept, a second paranet is created for the shared version. The user now has both a local and a shared version in their repo selector.

**Network partition (peer goes offline):**
- Collaborator status updates to "Offline" after 2 missed ping cycles (2 minutes)
- Invitations sent during a partition are not acknowledged until the peer reconnects
- "Sent Invitations" shows "Pending" indefinitely — no timeout, but a muted hint after 10 minutes: "This peer may be offline."

**Multiple shared spaces for the same repo:**
- Different teams can create independent shared spaces for the same GitHub repo (different suffixes)
- Each appears as a separate entry in the repo selector: `owner/repo (Shared: a1b2c3d4)` vs `owner/repo (Shared: x9y8z7w6)`
- The collaborator list is per-paranet, not per-repo

**Revoking access:**
- An owner can remove a collaborator by unsubscribing them (future: `POST /collaborators/:peerId/remove`)
- A collaborator can leave at any time by removing the repo from their node
- When a collaborator leaves, they broadcast `node:left` and unsubscribe from GossipSub

### 16.17 UI API Client Additions

These functions are added to `ui/src/api.ts`:

```typescript
// --- Invitations ---

export function sendInvitation(owner: string, repo: string, peerId: string) {
  return apiFetch('/invite', { method: 'POST', body: JSON.stringify({ owner, repo, peerId }) });
}

export function fetchInvitations(repo?: string) {
  const params = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return apiFetch(`/invitations${params}`);
}

export function acceptInvitation(invitationId: string) {
  return apiFetch(`/invitations/${invitationId}/accept`, { method: 'POST' });
}

export function declineInvitation(invitationId: string) {
  return apiFetch(`/invitations/${invitationId}/decline`, { method: 'POST' });
}

export function revokeInvitation(invitationId: string) {
  return apiFetch(`/invitations/${invitationId}`, { method: 'DELETE' });
}

// --- Collaborators ---

export function fetchCollaborators(owner: string, repo: string) {
  return apiFetch(`/collaborators?repo=${encodeURIComponent(`${owner}/${repo}`)}`);
}

// --- Conversion ---

export function convertToShared(owner: string, repo: string) {
  return apiFetch('/convert-to-shared', { method: 'POST', body: JSON.stringify({ owner, repo }) });
}
```

---

## 17. Auto Data Migration on Local-to-Shared Conversion (2026-03-25)

When a user converts a repository from Local Only to Shared mode, existing data in the old local workspace should be migrated to the new shared paranet workspace. This section defines the complete migration UX.

### 17.1 Migration Strategy: Re-sync from GitHub

**Decision**: Re-sync from GitHub rather than copying existing quads.

**Rationale**:
- The local workspace may contain stale or partial data from earlier sync runs
- A fresh sync guarantees the shared paranet starts with a clean, consistent snapshot
- Quad-level copy would require resolving graph URIs (the paranet ID changes, which changes the named graph), introducing fragile rewriting logic
- Re-sync is already a well-tested path (the sync engine handles it)
- The migration is a one-time operation per repo, so the extra GitHub API calls are acceptable

**Exception**: If the repo has no GitHub token configured (unlikely for an owner, but possible), fall back to quad copy with graph URI rewriting.

### 17.2 Migration UX Flow

**Trigger**: User clicks "Convert to Shared" in the conversion confirmation dialog (Section 16.7).

**Step 1 — Confirmation dialog** (extends Section 16.7):
```
┌──────────────────────────────────────────────────────────┐
│  Convert to Shared Mode?                                  │
│                                                          │
│  Repository: owner/repo                                  │
│                                                          │
│  This will:                                              │
│  * Create a shared space (paranet) for this repo         │
│  * Re-sync data from GitHub into the shared space        │
│  * Allow you to invite other DKG V9 nodes                │
│                                                          │
│  Your existing local data will remain on this node as    │
│  a read-only archive. The shared space gets a fresh      │
│  sync from GitHub.                                       │
│                                                          │
│  Estimated time: depends on repo size (typically 10-60s) │
│                                                          │
│              [Cancel]  [Convert & Sync]                   │
└──────────────────────────────────────────────────────────┘
```

**Step 2 — Progress indicator** (replaces the simple progress in 16.7):
```
┌──────────────────────────────────────────────────────────┐
│  Converting to Shared Mode...                             │
│                                                          │
│  [============================] Creating shared space     │
│  [============================] Subscribing to network    │
│  [================            ] Syncing from GitHub...    │
│                                 Fetching PRs: 12 found   │
│                                 Fetching issues: 34 found│
│                                 Building graph: 1,247     │
│                                 triples created           │
│  [                            ] Finalizing                │
│                                                          │
│                                           [Cancel]        │
└──────────────────────────────────────────────────────────┘
```

The progress display reuses the sync engine's phase reporting (same phases as "Sync Now" in Section 3.5). Each phase updates in-place.

**Step 3 — Success**:
```
┌──────────────────────────────────────────────────────────┐
│  Conversion Complete                                      │
│                                                          │
│  Shared Space ID: github-collab:owner/repo:a1b2c3d4      │
│  Data synced: 2,847 triples from GitHub                  │
│  Your local archive remains accessible.                  │
│                                                          │
│                              [View Collaboration Tab]     │
└──────────────────────────────────────────────────────────┘
```

**Step 4 — Tab refreshes** to State B (Shared, no peers).

### 17.3 Migration Failure Handling

**Failure during paranet creation** (Step 1 of backend):
- Show error: "Failed to create shared space. Your repo remains in Local Only mode."
- Offer "Retry" button
- No data is lost — nothing has changed yet

**Failure during sync** (Step 3 of backend — partial sync):
- The shared paranet already exists but has incomplete data
- Show warning: "Sync incomplete. {N} triples were written before the error. You can retry the sync from the Collaboration tab."
- The repo is now in Shared mode (conversion succeeded) but with partial data
- "Sync Now" button on Overview tab will complete the sync
- Activity log records the partial migration

**GitHub rate limit hit during sync**:
- Show: "GitHub API rate limit reached. The shared space was created successfully. Remaining data will sync on your next scheduled sync (or click 'Sync Now' when the rate limit resets at {time})."
- Conversion is considered successful — the paranet exists and the user can invite peers

**Network error during GossipSub subscription**:
- Show: "Shared space created but could not connect to the P2P network. Check your node's network configuration."
- The repo is in Shared mode locally but not discoverable until the node reconnects

### 17.4 Backend Sequence — `POST /convert-to-shared` (Extended)

```
1. Generate suffix → new paranetId
2. createParanet({ id: newParanetId, private: false })
3. subscribeToParanet(newParanetId)
4. Update repo config: privacyLevel = 'shared', paranetId = newParanetId
5. Broadcast node:joined
6. IF githubToken exists:
     startSync(owner, repo, allScopes)  // re-sync into new paranet
   ELSE:
     copyWorkspaceQuads(oldParanetId, newParanetId)  // fallback
7. Return { ok, paranetId, syncJobId? }
```

The caller can poll `GET /sync/status?jobId=X` to track sync progress during migration.

### 17.5 Local Archive Behavior

After conversion, the old local paranet data remains readable but is no longer updated. The sync engine writes exclusively to the new shared paranet.

- The old local paranet ID is stored in the repo config as `previousLocalParanetId`
- Users can query the local archive via SPARQL if needed (niche use case)
- No UI is provided to browse the archive — it is a safety net, not a feature
- Future: A "Delete Local Archive" option in Settings > Danger Zone

---

## 18. Agent Activity Recording (2026-03-25)

This is the core value proposition for multi-agent collaboration. Agents record structured activity so that other agents (and humans) can understand what is happening across the codebase.

### 18.1 Design Principles

1. **Agent-first API**: The primary consumers are coding agents (Claude Code, Cursor, OpenClaw). The API must be simple enough that an MCP tool or CLI wrapper can call it without complex setup.
2. **Structured, not free-form**: Activity data follows a schema that enables SPARQL queries, graph visualization, and conflict detection. Not a chat log.
3. **Session lifecycle**: Agents have explicit start/end boundaries for their work sessions. This enables duration tracking, cost estimation, and "what changed in this session" queries.
4. **File claims are advisory**: Claims signal intent, not hard locks. Two agents can work on the same file, but the system surfaces the conflict so they can coordinate.
5. **Decisions are first-class**: Architectural decisions are recorded with rationale, alternatives considered, and affected code entities. This creates institutional memory.
6. **Automatic linking**: Activity data links to existing graph entities (files, PRs, issues, functions). This enriches the knowledge graph over time.

### 18.2 Ontology — Agent Activity Classes

All classes use the `ghcode:` namespace (`https://ontology.dkg.io/ghcode#`). These extend the existing ontology.

```turtle
# --- Agent Session ---
ghcode:AgentSession a rdfs:Class ;
  rdfs:label "Agent Session" ;
  rdfs:comment "A bounded work session by a coding agent." .

ghcode:sessionId       a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
ghcode:agentName       a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
ghcode:agentType       a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
  # e.g., "claude-code", "cursor", "openclaw", "human"
ghcode:peerId          a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
ghcode:startedAt       a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:dateTime .
ghcode:endedAt         a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:dateTime .
ghcode:sessionStatus   a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
  # "active" | "completed" | "abandoned"
ghcode:summary         a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
ghcode:goal            a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
ghcode:modifiedFile    a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range ghcode:File .
ghcode:relatedPR       a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range ghcode:PullRequest .
ghcode:relatedIssue    a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range ghcode:Issue .
ghcode:estimatedCost   a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range xsd:string .
ghcode:inRepo          a rdf:Property ; rdfs:domain ghcode:AgentSession ; rdfs:range ghcode:Repository .

# --- Code Claim ---
ghcode:CodeClaim a rdfs:Class ;
  rdfs:label "Code Claim" ;
  rdfs:comment "An agent's advisory claim on a file or region." .

ghcode:claimId         a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:string .
ghcode:claimedFile     a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range ghcode:File .
ghcode:claimedPath     a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:string .
ghcode:claimedBy       a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:string .
  # Agent name (not URI — agents may not have persistent URIs)
ghcode:claimSession    a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range ghcode:AgentSession .
ghcode:claimStatus     a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:string .
  # "active" | "released" | "expired"
ghcode:claimedAt       a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:dateTime .
ghcode:releasedAt      a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:dateTime .
ghcode:claimReason     a rdf:Property ; rdfs:domain ghcode:CodeClaim ; rdfs:range xsd:string .

# --- Decision ---
ghcode:Decision a rdfs:Class ;
  rdfs:label "Architectural Decision" ;
  rdfs:comment "A recorded technical decision with rationale." .

ghcode:decisionId      a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:string .
ghcode:decisionSummary a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:string .
ghcode:rationale       a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:string .
ghcode:alternatives    a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:string .
  # Semicolon-separated list of alternatives considered
ghcode:madeBy          a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:string .
ghcode:madeAt          a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:dateTime .
ghcode:affectsFile     a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range ghcode:File .
ghcode:affectsEntity   a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range rdfs:Resource .
ghcode:inSession       a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range ghcode:AgentSession .
ghcode:decisionStatus  a rdf:Property ; rdfs:domain ghcode:Decision ; rdfs:range xsd:string .
  # "proposed" | "accepted" | "superseded" | "reverted"

# --- Annotation ---
ghcode:Annotation a rdfs:Class ;
  rdfs:label "Code Annotation" ;
  rdfs:comment "An agent's annotation on a code entity." .

ghcode:annotationId    a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range xsd:string .
ghcode:annotates       a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range rdfs:Resource .
ghcode:annotationText  a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range xsd:string .
ghcode:annotationType  a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range xsd:string .
  # "finding" | "suggestion" | "warning" | "note" | "review-comment"
ghcode:annotatedBy     a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range xsd:string .
ghcode:annotatedAt     a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range xsd:dateTime .
ghcode:inSession       a rdf:Property ; rdfs:domain ghcode:Annotation ; rdfs:range ghcode:AgentSession .
```

### 18.3 URI Minting for Agent Entities

New URI helper functions in `rdf/uri.ts`:

```typescript
export function agentSessionUri(repoOwner: string, repoName: string, sessionId: string): string {
  return `urn:github:${repoOwner}/${repoName}/session/${sessionId}`;
}

export function codeClaimUri(repoOwner: string, repoName: string, claimId: string): string {
  return `urn:github:${repoOwner}/${repoName}/claim/${claimId}`;
}

export function decisionUri(repoOwner: string, repoName: string, decisionId: string): string {
  return `urn:github:${repoOwner}/${repoName}/decision/${decisionId}`;
}

export function annotationUri(repoOwner: string, repoName: string, annotationId: string): string {
  return `urn:github:${repoOwner}/${repoName}/annotation/${annotationId}`;
}
```

### 18.4 Agent Session Lifecycle

```
Agent connects to repo
  │
  ├─ POST /sessions                         ← Start session
  │   Returns: { sessionId, startedAt }
  │
  ├─ POST /claims                           ← Claim files (optional)
  │   Returns: { claimId } or { conflict }
  │
  ├─ [Agent does work...]
  │
  ├─ POST /sessions/:id/heartbeat           ← Keep session alive (every 60s)
  │   Returns: { ok }
  │
  ├─ POST /decisions                         ← Record decisions (as needed)
  │   Returns: { decisionId }
  │
  ├─ POST /annotations                       ← Annotate entities (as needed)
  │   Returns: { annotationId }
  │
  ├─ POST /sessions/:id/files               ← Report modified files
  │   Returns: { ok }
  │
  └─ POST /sessions/:id/end                 ← End session with summary
      Returns: { ok, duration, filesModified, decisionsRecorded }
```

**Heartbeat**: Sessions without a heartbeat for 5 minutes are marked `abandoned`. This handles agents that crash or disconnect without ending their session. Abandoned sessions release all associated file claims.

**Session auto-cleanup**: A background timer in the coordinator checks for stale sessions every 2 minutes.

### 18.5 API Endpoints — Agent Activity

All endpoints under `/api/apps/github-collab`. Repo context is provided in the request body or URL path.

#### `POST /sessions`

Start a new agent session.

**Request:**
```json
{
  "repo": "owner/repo",
  "agent": "claude-code-1",
  "agentType": "claude-code",
  "goal": "Implement auth middleware for PR #42",
  "relatedPR": 42,
  "relatedIssue": 38
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "sess-a1b2c3d4",
  "startedAt": "2026-03-25T14:30:00.000Z",
  "sessionUri": "urn:github:owner/repo/session/sess-a1b2c3d4"
}
```

**Backend behavior:**
1. Generate session ID: `sess-${randomUUID().slice(0,8)}`
2. Create RDF quads for the session entity
3. Write to workspace via `coordinator.writeToWorkspace`
4. Store session in coordinator's in-memory map for heartbeat tracking
5. If shared mode: broadcast `session:started` GossipSub message
6. Return session ID to caller

**RDF produced:**
```turtle
<urn:github:owner/repo/session/sess-a1b2c3d4>
  a ghcode:AgentSession ;
  ghcode:sessionId "sess-a1b2c3d4" ;
  ghcode:agentName "claude-code-1" ;
  ghcode:agentType "claude-code" ;
  ghcode:peerId "12D3KooW..." ;
  ghcode:startedAt "2026-03-25T14:30:00.000Z"^^xsd:dateTime ;
  ghcode:sessionStatus "active" ;
  ghcode:goal "Implement auth middleware for PR #42" ;
  ghcode:relatedPR <urn:github:owner/repo/pr/42> ;
  ghcode:relatedIssue <urn:github:owner/repo/issue/38> ;
  ghcode:inRepo <urn:github:owner/repo> .
```

#### `POST /sessions/:id/heartbeat`

Keep a session alive. Called by the agent every 60 seconds.

**Response:**
```json
{
  "ok": true,
  "sessionAge": 300,
  "activeClaims": 2
}
```

**Backend behavior:**
1. Update the session's last heartbeat timestamp in memory
2. Return session age in seconds and number of active claims

#### `POST /sessions/:id/files`

Report files modified during this session (can be called multiple times, additive).

**Request:**
```json
{
  "files": [
    "src/auth/handler.ts",
    "src/auth/middleware.ts",
    "test/auth.test.ts"
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "totalFiles": 3
}
```

**Backend behavior:**
1. For each file path, create a `ghcode:modifiedFile` triple linking the session to the file URI
2. Write quads to workspace
3. Check for claim conflicts (files claimed by other agents) and include warnings in response:
```json
{
  "ok": true,
  "totalFiles": 3,
  "warnings": [
    { "file": "src/auth/handler.ts", "claimedBy": "cursor-agent-1", "since": "2026-03-25T14:28:00Z" }
  ]
}
```

#### `POST /sessions/:id/end`

End a session with a summary of work done.

**Request:**
```json
{
  "summary": "Implemented JWT auth middleware with refresh token support. Added 3 test cases.",
  "filesModified": ["src/auth/handler.ts", "src/auth/middleware.ts", "test/auth.test.ts"],
  "estimatedCost": "$0.45"
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "sess-a1b2c3d4",
  "duration": 1800,
  "filesModified": 3,
  "decisionsRecorded": 2,
  "claimsReleased": 2
}
```

**Backend behavior:**
1. Update session status to `completed`
2. Write `ghcode:endedAt`, `ghcode:summary`, `ghcode:sessionStatus "completed"` quads
3. Release all file claims associated with this session
4. If shared mode: broadcast `session:ended` GossipSub message
5. Remove session from heartbeat tracking map

#### `POST /claims`

Claim a file or set of files for exclusive work.

**Request:**
```json
{
  "repo": "owner/repo",
  "files": ["src/auth/handler.ts", "src/auth/middleware.ts"],
  "agent": "claude-code-1",
  "sessionId": "sess-a1b2c3d4",
  "reason": "Refactoring auth flow"
}
```

**Response (success — no conflicts):**
```json
{
  "ok": true,
  "claims": [
    { "claimId": "clm-x1y2z3", "file": "src/auth/handler.ts", "status": "active" },
    { "claimId": "clm-x4y5z6", "file": "src/auth/middleware.ts", "status": "active" }
  ]
}
```

**Response (conflict — file already claimed):**
```json
{
  "ok": true,
  "claims": [
    { "claimId": "clm-x1y2z3", "file": "src/auth/handler.ts", "status": "active" },
    {
      "file": "src/auth/middleware.ts",
      "status": "conflict",
      "existingClaim": {
        "claimId": "clm-prev-1",
        "claimedBy": "cursor-agent-1",
        "since": "2026-03-25T14:28:00Z",
        "reason": "Adding error handling"
      }
    }
  ]
}
```

**Conflict policy**: Claims are advisory. When a conflict is detected:
- The new claim is **not** created for the conflicting file
- The response includes the existing claim details
- The agent can decide to: (a) wait, (b) proceed anyway without a claim, (c) negotiate via an agent thread
- The UI shows a conflict indicator on the file in the Claims table

**Backend behavior:**
1. For each file, check if an active claim exists from a different agent
2. If no conflict: create claim, write quads, return claim ID
3. If conflict: return conflict details, do not create claim
4. Broadcast `claim:created` GossipSub message for successful claims

**RDF produced (per claim):**
```turtle
<urn:github:owner/repo/claim/clm-x1y2z3>
  a ghcode:CodeClaim ;
  ghcode:claimId "clm-x1y2z3" ;
  ghcode:claimedFile <urn:github:owner/repo/file/src%2Fauth%2Fhandler.ts> ;
  ghcode:claimedPath "src/auth/handler.ts" ;
  ghcode:claimedBy "claude-code-1" ;
  ghcode:claimSession <urn:github:owner/repo/session/sess-a1b2c3d4> ;
  ghcode:claimStatus "active" ;
  ghcode:claimedAt "2026-03-25T14:30:05Z"^^xsd:dateTime ;
  ghcode:claimReason "Refactoring auth flow" ;
  ghcode:inRepo <urn:github:owner/repo> .
```

#### `DELETE /claims/:claimId`

Release a specific file claim.

**Response:**
```json
{
  "ok": true,
  "claimId": "clm-x1y2z3",
  "releasedAt": "2026-03-25T15:30:00Z"
}
```

**Backend behavior:**
1. Update claim status to `released`, write `ghcode:releasedAt` quad
2. Broadcast `claim:released` GossipSub message

#### `GET /claims`

List active file claims for a repo.

**Query params:** `?repo=owner/repo&agent=claude-code-1` (agent filter optional)

**Response:**
```json
{
  "claims": [
    {
      "claimId": "clm-x1y2z3",
      "file": "src/auth/handler.ts",
      "agent": "claude-code-1",
      "sessionId": "sess-a1b2c3d4",
      "since": "2026-03-25T14:30:05Z",
      "reason": "Refactoring auth flow"
    }
  ]
}
```

**Data source:** SPARQL query on workspace:
```sparql
SELECT ?claimId ?path ?agent ?sessionId ?since ?reason WHERE {
  ?claim a ghcode:CodeClaim ;
         ghcode:claimId ?claimId ;
         ghcode:claimedPath ?path ;
         ghcode:claimedBy ?agent ;
         ghcode:claimStatus "active" ;
         ghcode:claimedAt ?since ;
         ghcode:inRepo <urn:github:{owner}/{repo}> .
  OPTIONAL { ?claim ghcode:claimSession ?sess . ?sess ghcode:sessionId ?sessionId }
  OPTIONAL { ?claim ghcode:claimReason ?reason }
}
ORDER BY ?path
```

#### `POST /decisions`

Record an architectural decision.

**Request:**
```json
{
  "repo": "owner/repo",
  "summary": "Use JWT with refresh tokens instead of session cookies",
  "rationale": "Stateless auth scales better with our microservices architecture. Session cookies would require a shared session store.",
  "alternatives": "Session cookies with Redis; OAuth2 with external provider",
  "agent": "claude-code-1",
  "sessionId": "sess-a1b2c3d4",
  "affectedFiles": ["src/auth/handler.ts", "src/auth/middleware.ts"],
  "affectedEntities": ["urn:github:owner/repo/file/src%2Fauth%2Fhandler.ts"],
  "status": "accepted"
}
```

**Response:**
```json
{
  "ok": true,
  "decisionId": "dec-m1n2o3p4",
  "decisionUri": "urn:github:owner/repo/decision/dec-m1n2o3p4"
}
```

**RDF produced:**
```turtle
<urn:github:owner/repo/decision/dec-m1n2o3p4>
  a ghcode:Decision ;
  ghcode:decisionId "dec-m1n2o3p4" ;
  ghcode:decisionSummary "Use JWT with refresh tokens instead of session cookies" ;
  ghcode:rationale "Stateless auth scales better..." ;
  ghcode:alternatives "Session cookies with Redis; OAuth2 with external provider" ;
  ghcode:madeBy "claude-code-1" ;
  ghcode:madeAt "2026-03-25T14:35:00Z"^^xsd:dateTime ;
  ghcode:affectsFile <urn:github:owner/repo/file/src%2Fauth%2Fhandler.ts> ;
  ghcode:affectsFile <urn:github:owner/repo/file/src%2Fauth%2Fmiddleware.ts> ;
  ghcode:inSession <urn:github:owner/repo/session/sess-a1b2c3d4> ;
  ghcode:decisionStatus "accepted" ;
  ghcode:inRepo <urn:github:owner/repo> .
```

#### `POST /annotations`

Annotate a code entity (file, function, class).

**Request:**
```json
{
  "repo": "owner/repo",
  "entity": "urn:github:owner/repo/file/src%2Fauth%2Fhandler.ts",
  "text": "Missing error handling in login flow — if JWT verification throws, the request hangs",
  "type": "finding",
  "agent": "claude-code-1",
  "sessionId": "sess-a1b2c3d4"
}
```

**Response:**
```json
{
  "ok": true,
  "annotationId": "ann-q1r2s3t4"
}
```

#### `GET /sessions`

List agent sessions for a repo.

**Query params:** `?repo=owner/repo&status=active&agent=claude-code-1&limit=20`

**Response:**
```json
{
  "sessions": [
    {
      "sessionId": "sess-a1b2c3d4",
      "agent": "claude-code-1",
      "agentType": "claude-code",
      "status": "active",
      "goal": "Implement auth middleware for PR #42",
      "startedAt": "2026-03-25T14:30:00Z",
      "endedAt": null,
      "duration": null,
      "filesModified": ["src/auth/handler.ts"],
      "relatedPR": 42,
      "relatedIssue": 38,
      "claimCount": 2,
      "decisionCount": 1
    }
  ]
}
```

**Data source:** SPARQL query:
```sparql
SELECT ?sessionId ?agent ?agentType ?status ?goal ?startedAt ?endedAt WHERE {
  ?s a ghcode:AgentSession ;
     ghcode:sessionId ?sessionId ;
     ghcode:agentName ?agent ;
     ghcode:sessionStatus ?status ;
     ghcode:startedAt ?startedAt ;
     ghcode:inRepo <urn:github:{owner}/{repo}> .
  OPTIONAL { ?s ghcode:agentType ?agentType }
  OPTIONAL { ?s ghcode:goal ?goal }
  OPTIONAL { ?s ghcode:endedAt ?endedAt }
  FILTER(?status = "active")
}
ORDER BY DESC(?startedAt)
LIMIT 20
```

#### `GET /decisions`

List architectural decisions for a repo.

**Query params:** `?repo=owner/repo&agent=claude-code-1&limit=20`

**Response:**
```json
{
  "decisions": [
    {
      "decisionId": "dec-m1n2o3p4",
      "summary": "Use JWT with refresh tokens instead of session cookies",
      "rationale": "Stateless auth scales better...",
      "alternatives": "Session cookies with Redis; OAuth2 with external provider",
      "agent": "claude-code-1",
      "madeAt": "2026-03-25T14:35:00Z",
      "status": "accepted",
      "affectedFiles": ["src/auth/handler.ts", "src/auth/middleware.ts"],
      "sessionId": "sess-a1b2c3d4"
    }
  ]
}
```

#### `GET /activity`

Unified activity feed combining sessions, claims, decisions, and annotations.

**Query params:** `?repo=owner/repo&since=2026-03-25T00:00:00Z&limit=50`

**Response:**
```json
{
  "activities": [
    {
      "type": "session:started",
      "agent": "claude-code-1",
      "timestamp": "2026-03-25T14:30:00Z",
      "detail": "Started session: Implement auth middleware for PR #42",
      "sessionId": "sess-a1b2c3d4",
      "entityUri": "urn:github:owner/repo/session/sess-a1b2c3d4"
    },
    {
      "type": "claim:created",
      "agent": "claude-code-1",
      "timestamp": "2026-03-25T14:30:05Z",
      "detail": "Claimed src/auth/handler.ts",
      "entityUri": "urn:github:owner/repo/claim/clm-x1y2z3"
    },
    {
      "type": "decision:recorded",
      "agent": "claude-code-1",
      "timestamp": "2026-03-25T14:35:00Z",
      "detail": "Decision: Use JWT with refresh tokens instead of session cookies",
      "entityUri": "urn:github:owner/repo/decision/dec-m1n2o3p4"
    },
    {
      "type": "session:ended",
      "agent": "claude-code-1",
      "timestamp": "2026-03-25T15:00:00Z",
      "detail": "Completed session (30 min, 3 files modified)",
      "sessionId": "sess-a1b2c3d4"
    }
  ]
}
```

**Data source:** Union SPARQL query across all activity types:
```sparql
SELECT ?type ?agent ?ts ?detail ?uri WHERE {
  {
    ?s a ghcode:AgentSession ; ghcode:agentName ?agent ; ghcode:startedAt ?ts ;
       ghcode:goal ?goal ; ghcode:inRepo <urn:github:{owner}/{repo}> .
    BIND("session:started" AS ?type) BIND(?s AS ?uri)
    BIND(CONCAT("Started session: ", ?goal) AS ?detail)
  } UNION {
    ?s a ghcode:AgentSession ; ghcode:agentName ?agent ; ghcode:endedAt ?ts ;
       ghcode:summary ?sum ; ghcode:inRepo <urn:github:{owner}/{repo}> .
    BIND("session:ended" AS ?type) BIND(?s AS ?uri)
    BIND(CONCAT("Completed session: ", ?sum) AS ?detail)
  } UNION {
    ?c a ghcode:CodeClaim ; ghcode:claimedBy ?agent ; ghcode:claimedAt ?ts ;
       ghcode:claimedPath ?path ; ghcode:inRepo <urn:github:{owner}/{repo}> .
    BIND("claim:created" AS ?type) BIND(?c AS ?uri)
    BIND(CONCAT("Claimed ", ?path) AS ?detail)
  } UNION {
    ?d a ghcode:Decision ; ghcode:madeBy ?agent ; ghcode:madeAt ?ts ;
       ghcode:decisionSummary ?sum ; ghcode:inRepo <urn:github:{owner}/{repo}> .
    BIND("decision:recorded" AS ?type) BIND(?d AS ?uri)
    BIND(CONCAT("Decision: ", ?sum) AS ?detail)
  }
  FILTER(?ts > "{since}"^^xsd:dateTime)
}
ORDER BY DESC(?ts)
LIMIT {limit}
```

### 18.6 GossipSub Messages — Agent Activity

New message types added to `protocol.ts`:

```typescript
export type MessageType =
  | /* existing types */
  | 'session:started'     // Agent started a work session
  | 'session:ended'       // Agent ended a work session
  | 'session:heartbeat'   // Agent is still active
  | 'claim:created'       // Agent claimed a file
  | 'claim:released'      // Agent released a claim
  | 'claim:conflict'      // Claim conflict detected
  | 'decision:recorded';  // Agent recorded a decision

export interface SessionStartedMessage extends BaseMessage {
  type: 'session:started';
  repo: string;
  sessionId: string;
  agent: string;
  agentType: string;
  goal?: string;
}

export interface SessionEndedMessage extends BaseMessage {
  type: 'session:ended';
  repo: string;
  sessionId: string;
  agent: string;
  summary?: string;
  duration: number;        // seconds
  filesModified: number;
}

export interface ClaimCreatedMessage extends BaseMessage {
  type: 'claim:created';
  repo: string;
  claimId: string;
  file: string;
  agent: string;
}

export interface ClaimConflictMessage extends BaseMessage {
  type: 'claim:conflict';
  repo: string;
  file: string;
  claimingAgent: string;
  existingAgent: string;
}

export interface DecisionRecordedMessage extends BaseMessage {
  type: 'decision:recorded';
  repo: string;
  decisionId: string;
  summary: string;
  agent: string;
}
```

### 18.7 Agent Activity — UI: "Agent Activity" Tab

The existing "Peers & Agents" tab (Section 3.6, 5.6) is extended with an **Agent Activity** sub-view. This is a new sub-tab alongside the existing collaboration features.

**Tab structure**:
```
Collaboration
├── Peers & Invitations    (existing — Section 16)
├── Agent Activity         (NEW — this section)
└── Agent Activity Graph   (NEW — graph visualization)
```

#### 18.7.1 Agent Activity Tab — List/Timeline View

```
┌──────────────────────────────────────────────────────────────┐
│  AGENT ACTIVITY                                    [Filters]  │
│                                                              │
│  ACTIVE SESSIONS (2)                                         │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  ● claude-code-1                          Active 25m  │    │
│  │    Goal: Implement auth middleware for PR #42         │    │
│  │    Files: src/auth/handler.ts (+2 more)               │    │
│  │    Claims: 2 files claimed                            │    │
│  │    Decisions: 1 recorded                              │    │
│  │                                                      │    │
│  │  ● cursor-agent-1                         Active 8m   │    │
│  │    Goal: Fix login timeout (Issue #38)                │    │
│  │    Files: src/auth/session.ts                         │    │
│  │    Claims: 1 file claimed                             │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  FILE CLAIMS                                                 │
│  ┌─────────────────────┬──────────────┬─────────┬────────┐  │
│  │ File                │ Agent        │ Since   │ Reason │  │
│  ├─────────────────────┼──────────────┼─────────┼────────┤  │
│  │ src/auth/handler.ts │ claude-code-1│ 25m ago │ Refact │  │
│  │ src/auth/middle...  │ claude-code-1│ 25m ago │ Refact │  │
│  │ src/auth/session.ts │ cursor-agt-1 │ 8m ago  │ Fix    │  │
│  └─────────────────────┴──────────────┴─────────┴────────┘  │
│                                                              │
│  DECISIONS                                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  dec-m1n2o3p4  25 min ago  claude-code-1              │    │
│  │  "Use JWT with refresh tokens instead of session      │    │
│  │   cookies"                                            │    │
│  │  Rationale: Stateless auth scales better...           │    │
│  │  Affects: handler.ts, middleware.ts                    │    │
│  │  Status: accepted                                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  TIMELINE                                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  14:35  claude-code-1  Decision: Use JWT with...      │    │
│  │  14:30  claude-code-1  Claimed src/auth/handler.ts    │    │
│  │  14:30  claude-code-1  Started session (PR #42)       │    │
│  │  14:22  cursor-agent-1 Claimed src/auth/session.ts    │    │
│  │  14:22  cursor-agent-1 Started session (Issue #38)    │    │
│  │  14:00  claude-code-1  Completed session (45 min)     │    │
│  │         "Reviewed PR #40 and approved"                │    │
│  │  ...                                         [Load more] │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**Data sources:**
| Section | Endpoint | Poll Interval |
|---------|----------|---------------|
| Active Sessions | `GET /sessions?repo=X&status=active` | 10 seconds |
| File Claims | `GET /claims?repo=X` | 15 seconds |
| Decisions | `GET /decisions?repo=X&limit=5` | 30 seconds |
| Timeline | `GET /activity?repo=X&limit=50` | 10 seconds |

**Filters** (top-right dropdown):
- Agent: All / specific agent name
- Time range: Last hour / Last 24h / Last 7 days / All time
- Activity type: All / Sessions / Claims / Decisions

**Interactions**:
- Click a session → expand to show full details (files, decisions, annotations)
- Click a file claim → navigate to that file in the Graph Explorer
- Click a decision → expand to show rationale and alternatives
- Click a timeline entry → navigate to the related entity

#### 18.7.2 Agent Activity Graph View

Uses the `agentActivityView` ViewConfig already defined in Section 8.5. The SPARQL CONSTRUCT query that populates this view:

```sparql
CONSTRUCT {
  ?session a ghcode:AgentSession ;
           ghcode:agentName ?agent ;
           ghcode:sessionStatus ?status ;
           ghcode:startedAt ?started ;
           ghcode:goal ?goal .
  ?session ghcode:modifiedFile ?file .
  ?file ghcode:filePath ?filePath .
  ?claim ghcode:claimedFile ?file ;
         ghcode:claimedBy ?claimAgent .
  ?decision a ghcode:Decision ;
            ghcode:decisionSummary ?decSum ;
            ghcode:madeBy ?decAgent .
  ?decision ghcode:affectsFile ?decFile .
  ?session ghcode:relatedPR ?pr .
  ?pr ghcode:prNumber ?prNum ;
      ghcode:title ?prTitle .
}
WHERE {
  {
    ?session a ghcode:AgentSession ;
             ghcode:agentName ?agent ;
             ghcode:sessionStatus ?status ;
             ghcode:startedAt ?started ;
             ghcode:inRepo <urn:github:{owner}/{repo}> .
    OPTIONAL { ?session ghcode:goal ?goal }
    OPTIONAL { ?session ghcode:modifiedFile ?file . ?file ghcode:filePath ?filePath }
    OPTIONAL { ?session ghcode:relatedPR ?pr .
               ?pr ghcode:prNumber ?prNum .
               OPTIONAL { ?pr ghcode:title ?prTitle } }
  } UNION {
    ?claim a ghcode:CodeClaim ;
           ghcode:claimedFile ?file ;
           ghcode:claimedBy ?claimAgent ;
           ghcode:claimStatus "active" ;
           ghcode:inRepo <urn:github:{owner}/{repo}> .
  } UNION {
    ?decision a ghcode:Decision ;
              ghcode:decisionSummary ?decSum ;
              ghcode:madeBy ?decAgent ;
              ghcode:inRepo <urn:github:{owner}/{repo}> .
    OPTIONAL { ?decision ghcode:affectsFile ?decFile }
  }
}
```

**Visual layout**: The graph shows agents as large green hexagons at the center, with sessions radiating outward, connected to files (blue circles), PRs (green hexagons), and decisions (amber hexagons). Claims are shown as edges between agents and files with a distinctive dashed style. The temporal playback feature (Section 8.5) allows scrubbing through time to see how agent activity evolved.

#### 18.7.3 How Activity Enriches Existing Graph Views

Agent activity data creates new edges in the knowledge graph that enhance existing views:

**Code Structure view** (Section 8.1):
- Files with active claims show a colored border matching the claiming agent
- Tooltip includes: "Claimed by claude-code-1 (25 min ago)"
- Files modified in recent sessions show a subtle glow effect

**PR Impact view** (Section 8.3):
- Agent sessions linked to a PR appear as satellite nodes
- Decisions linked to the PR show as amber nodes with rationale in tooltip
- Annotations on affected files appear as small note icons

**Dependencies view** (Section 8.2):
- No direct enhancement — agent activity is orthogonal to dependency structure

### 18.8 Component Hierarchy — Agent Activity

```
<CollaborationPage>
├── <CollaborationSubTabs>           # [Peers & Invitations, Agent Activity, Activity Graph]
│
├── <AgentActivityTab>               # List/timeline view
│   ├── <ActivityFilters>            # Agent, time range, type dropdowns
│   ├── <ActiveSessionsList>         # Currently active sessions
│   │   └── <ActiveSessionCard>      # Expandable session card
│   │       ├── <SessionHeader>      # Agent name, status badge, duration
│   │       ├── <SessionGoal>        # Goal text
│   │       ├── <SessionFiles>       # Modified files list
│   │       ├── <SessionClaims>      # Claim count with expand
│   │       └── <SessionDecisions>   # Decision count with expand
│   ├── <FileClaimsTable>            # Active file claims
│   │   └── <FileClaimRow>           # File, agent, since, reason
│   ├── <DecisionsList>              # Recent decisions
│   │   └── <DecisionCard>           # Expandable decision with rationale
│   └── <ActivityTimeline>           # Chronological feed
│       └── <TimelineEntry>          # Timestamp, agent, action, detail
│
├── <AgentActivityGraphTab>          # Graph visualization
│   ├── <GraphCanvas>                # RdfGraph with agentActivityView config
│   └── <TemporalControls>           # Play/pause, speed, time range
```

---

## 19. Collaborator Write Access (2026-03-25)

This section defines what collaborator agents (who accepted a paranet invitation) can write to the shared knowledge graph, and how those writes are processed.

### 19.1 Write Permission Model

| Entity Type | Owner Node | Collaborator Node |
|-------------|-----------|-------------------|
| Agent sessions (own) | Yes | Yes |
| Agent sessions (others) | No | No |
| Code claims (own) | Yes | Yes |
| Code claims (others) | Release only | No |
| Decisions | Yes | Yes |
| Annotations | Yes | Yes |
| GitHub sync (trigger) | Yes | No |
| PR review submission | Yes | Yes |
| Enshrinement (trigger) | Yes | No |
| Custom annotations | Yes | Yes |

**Key constraint**: Collaborators cannot trigger GitHub sync (they don't have the GitHub token) or enshrinement (that's the owner's prerogative). They can record their own activity, make claims, record decisions, and submit reviews.

**Identity**: Each write is tagged with the writer's `peerId` (from their DKG node). The peerId is non-forgeable — it's derived from the node's libp2p keypair. The `agentName` is self-reported and used for display only.

### 19.2 Write Flow — How Writes Become RDF

```
Agent calls POST /sessions (or /claims, /decisions, /annotations)
  │
  ├─ API handler validates request body
  │
  ├─ Coordinator generates entity ID and mints URI
  │
  ├─ Coordinator creates Quad[] using rdf/uri.ts helpers
  │   (tripleUri, tripleStr, tripleDateTime, etc.)
  │
  ├─ coordinator.writeToWorkspace(paranetId, quads)
  │   │
  │   ├─ Writes quads to local triple store (workspace)
  │   │
  │   └─ If shared mode:
  │       ├─ GossipSub broadcast (type-specific message)
  │       └─ Quads are available to peers querying the workspace
  │
  └─ Return entity ID + URI to caller
```

### 19.3 Collaborator API Endpoints

Collaborators use the **exact same endpoints** as the owner node. The endpoints are repo-scoped, and the coordinator determines write permissions based on the node's role for that repo.

**Permitted for collaborators** (same request/response schemas as Section 18.5):
```
POST   /sessions                    ← Start own session
POST   /sessions/:id/heartbeat     ← Keep session alive
POST   /sessions/:id/files         ← Report files modified
POST   /sessions/:id/end           ← End session
POST   /claims                     ← Claim files
DELETE /claims/:claimId            ← Release own claims
POST   /decisions                  ← Record decisions
POST   /annotations                ← Annotate entities
GET    /sessions                   ← Read all sessions
GET    /claims                     ← Read all claims
GET    /decisions                  ← Read all decisions
GET    /activity                   ← Read activity feed
```

**Denied for collaborators** (return 403):
```
POST   /sync                       ← Requires GitHub token
POST   /config/repo                ← Repo management is owner-only
DELETE /config/repo                ← Repo removal is owner-only
POST   /convert-to-shared          ← Conversion is owner-only
```

**Role detection**: The coordinator checks `repoConfig.role` (set during invitation acceptance):
- `role: 'owner'` — full access
- `role: 'collaborator'` — write own activity, read everything, no sync/config

### 19.4 Conflict Prevention — File Claims

The file claim system is the primary mechanism for preventing conflicting work between agents.

#### 19.4.1 Claim Resolution Rules

1. **First claim wins**: The first agent to claim a file gets the active claim. Subsequent claims for the same file return a conflict response.

2. **Claims are advisory**: A conflict response does not prevent the agent from modifying the file. It surfaces the conflict so agents can decide how to proceed.

3. **Claims are scoped to sessions**: When a session ends, all its claims are automatically released.

4. **Claims expire with heartbeats**: If an agent's session heartbeat lapses (5 minutes without heartbeat), the session is marked abandoned and its claims are released.

5. **No CAS (compare-and-swap)**: Workspace writes are append-only in the DKG model. There is no atomic compare-and-swap for RDF quads. Instead, the coordinator maintains an in-memory claim map that is the source of truth for conflict detection.

#### 19.4.2 Claim Conflict Handling

When a conflict is detected:

```
Agent A claims file X (succeeds → active)
  │
Agent B claims file X (conflict detected)
  │
  ├─ Response: { status: "conflict", existingClaim: { claimedBy: "Agent A", ... } }
  │
  ├─ GossipSub: claim:conflict message broadcast
  │   (all peers see the conflict in their activity feed)
  │
  └─ Agent B can:
      ├─ Wait for Agent A to release (poll GET /claims)
      ├─ Proceed without a claim (risky — changes may conflict)
      └─ Send a message via agent thread (future: POST /threads)
```

#### 19.4.3 Claim Conflict in the UI

```
┌──────────────────────────────────────────────────────────┐
│  FILE CLAIMS                                              │
│                                                          │
│  ┌──────────────────┬──────────────┬─────────┬────────┐  │
│  │ File             │ Agent        │ Since   │ Status │  │
│  ├──────────────────┼──────────────┼─────────┼────────┤  │
│  │ src/auth/handler │ claude-code-1│ 25m ago │ Active │  │
│  │   ⚠ cursor-agt-1 attempted claim 8m ago            │  │
│  │ src/auth/session │ cursor-agt-1 │ 8m ago  │ Active │  │
│  └──────────────────┴──────────────┴─────────┴────────┘  │
└──────────────────────────────────────────────────────────┘
```

Conflicted files show an amber warning icon with the name of the agent that attempted the conflicting claim. This surfaces potential coordination needs to the human operator.

### 19.5 Write Propagation — GossipSub

When a collaborator writes to their local workspace, the data must propagate to other peers:

1. **Local write**: Quads are written to the local triple store via `writeToWorkspace`
2. **GossipSub broadcast**: A typed message (e.g., `session:started`) is broadcast on the paranet's app topic
3. **Peer handling**: Other nodes receive the GossipSub message and:
   - Update their in-memory state (claim maps, session tracking)
   - The quads themselves are available via workspace queries (the DKG workspace sync handles quad propagation)
4. **Eventual consistency**: There is no global lock or consensus for workspace writes. Writes are eventually consistent across peers. The claim map is the only source of conflict detection, and it is maintained per-node from GossipSub messages.

### 19.6 Security Considerations

**Peer identity**: All writes are tagged with the writer's `peerId`, which is derived from their libp2p keypair. This cannot be spoofed without the private key.

**Agent name spoofing**: The `agentName` field is self-reported and could be spoofed. The UI should display the `peerId` alongside the agent name for verification when needed.

**Write validation**: The coordinator validates:
- Required fields are present
- Entity URIs reference the correct repo (no cross-repo writes)
- The writer's role permits the operation
- File paths are sanitized (no path traversal)

**No delete**: Collaborators cannot delete quads from the workspace. The workspace is append-only. "Releasing" a claim writes a new `claimStatus: released` quad rather than deleting the original.

### 19.7 UI API Client Additions — Collaborator Writes

These functions are added to `ui/src/api.ts`:

```typescript
// --- Agent Sessions ---

export function startSession(repo: string, agent: string, opts?: {
  agentType?: string; goal?: string; relatedPR?: number; relatedIssue?: number;
}) {
  return apiFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ repo, agent, ...opts }),
  });
}

export function endSession(sessionId: string, summary: string, filesModified?: string[]) {
  return apiFetch(`/sessions/${sessionId}/end`, {
    method: 'POST',
    body: JSON.stringify({ summary, filesModified }),
  });
}

export function heartbeatSession(sessionId: string) {
  return apiFetch(`/sessions/${sessionId}/heartbeat`, { method: 'POST' });
}

export function reportSessionFiles(sessionId: string, files: string[]) {
  return apiFetch(`/sessions/${sessionId}/files`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });
}

export function fetchSessions(repo: string, opts?: {
  status?: 'active' | 'completed' | 'abandoned'; agent?: string; limit?: number;
}) {
  const params = new URLSearchParams({ repo });
  if (opts?.status) params.set('status', opts.status);
  if (opts?.agent) params.set('agent', opts.agent);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/sessions?${params}`);
}

// --- Claims ---

export function createClaims(repo: string, files: string[], agent: string, sessionId: string, reason?: string) {
  return apiFetch('/claims', {
    method: 'POST',
    body: JSON.stringify({ repo, files, agent, sessionId, reason }),
  });
}

export function releaseClaim(claimId: string) {
  return apiFetch(`/claims/${claimId}`, { method: 'DELETE' });
}

export function fetchClaims(repo: string, agent?: string) {
  const params = new URLSearchParams({ repo });
  if (agent) params.set('agent', agent);
  return apiFetch(`/claims?${params}`);
}

// --- Decisions ---

export function recordDecision(repo: string, opts: {
  summary: string; rationale: string; alternatives?: string;
  agent: string; sessionId?: string; affectedFiles?: string[];
  status?: string;
}) {
  return apiFetch('/decisions', {
    method: 'POST',
    body: JSON.stringify({ repo, ...opts }),
  });
}

export function fetchDecisions(repo: string, opts?: { agent?: string; limit?: number }) {
  const params = new URLSearchParams({ repo });
  if (opts?.agent) params.set('agent', opts.agent);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/decisions?${params}`);
}

// --- Annotations ---

export function createAnnotation(repo: string, opts: {
  entity: string; text: string; type: string; agent: string; sessionId?: string;
}) {
  return apiFetch('/annotations', {
    method: 'POST',
    body: JSON.stringify({ repo, ...opts }),
  });
}

// --- Activity Feed ---

export function fetchActivity(repo: string, opts?: { since?: string; limit?: number }) {
  const params = new URLSearchParams({ repo });
  if (opts?.since) params.set('since', opts.since);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/activity?${params}`);
}
```
