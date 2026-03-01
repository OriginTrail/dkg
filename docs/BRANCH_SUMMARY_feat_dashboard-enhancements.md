# Branch summary: `feat/dashboard-enhancements`

**Source:** https://github.com/OriginTrail/dkg-v9/tree/feat/dashboard-enhancements  
**Author:** Marc Anthony  
**Commit:** `79b50d4` — feat(node-ui): dashboard enhancements - online status & graph filters  
**Base:** Branch is 1 commit ahead of `46be9d4` (main from earlier state).

---

## Summary

Adds **Node UI dashboard improvements**: peer online/offline and transport (direct vs relayed) in Messages, and a richer Knowledge Explorer with graph filters, paranet filter, search, type colors, and a node details panel.

---

## Changes by area

### 1. CLI / API server (`packages/cli`)

- **config.ts**
  - New optional `apiHost?: string` (default `'127.0.0.1'`). Use `'0.0.0.0'` to bind the API (and Node UI) so it’s reachable from other machines (e.g. VPS, LAN).
- **daemon.ts**
  - API server binds to `config.apiHost || '127.0.0.1'` instead of hardcoded `'127.0.0.1'`.
  - Log lines show the actual host, e.g. `API listening on http://0.0.0.0:9200`, `Node UI: http://0.0.0.0:9200/ui`.

**Note:** The daemon already exposes `connectionStatus` and `connectionTransport` on `/api/agents`; the branch only uses these in the UI.

---

### 2. Messages page (`packages/node-ui/src/ui/pages/Messages.tsx`)

- **Agent type**
  - `connectionStatus?: 'connected' | 'disconnected' | 'self'`
  - `connectionTransport?: 'direct' | 'relayed'`
- **OnlineIndicator**
  - Green dot = connected, gray = offline; tooltip shows “Online (direct)”, “Online (relayed)”, or “Offline”.
- **Peer list**
  - Each peer shows the indicator next to the name.
- **Chat header**
  - Selected peer shows the same indicator and, when connected, “· direct” or “· relayed” next to the peer ID.

---

### 3. Explorer / Graph tab (`packages/node-ui/src/ui/pages/Explorer.tsx`)

- **Paranet filter**
  - Dropdown “All Paranets” or a specific paranet; CONSTRUCT query is scoped to that graph when selected.
- **Type filter**
  - Dropdown: All Types, Knowledge Assets, Knowledge Collections, Agents, Software Agents, Datasets. Filters displayed triples by `rdf:type` (client-side over loaded data).
- **Search**
  - Text input “Search nodes…” filters by subject/object containing the string (case-insensitive).
- **Show literals**
  - Checkbox to include or hide literal nodes in the graph (same as existing “literals as nodes” behavior when on).
- **Type colors & legend**
  - Fixed colors per type (e.g. green KA, blue KC, purple Agent) and a small legend below the toolbar.
- **Node details panel**
  - Clicking a node opens a side panel with: URI, types (with same colors), “Properties” (outgoing triples, first 20), “Referenced by” (incoming, first 10). Close button to collapse.
- **Layout**
  - Toolbar with two rows (filters + limit/refresh), legend, then graph; details panel on the right when a node is selected. Responsive (e.g. `graph-explorer-layout`).

---

### 4. Styles (`packages/node-ui/src/ui/styles.css`)

- **Messages**
  - `.chat-peer-name` / `.chat-header-name`: flex + gap for indicator + text.
  - `.online-indicator` (8px circle), `.online-indicator.online` (green + glow), `.online-indicator.offline` (muted).
  - `.chat-status-text` for “· direct” / “· relayed”.
- **Explorer**
  - `.graph-explorer-layout`, `.graph-explorer-main`, `.graph-toolbar`, `.graph-legend`, `.graph-details-panel`, `.graph-details-header`, `.graph-details-body`, `.graph-details-section`, `.graph-details-triples`, `.graph-legend-dot`, etc.
  - Also adds/uses `.ka-graph-*` and `.checkbox-label` for the new Explorer UI.

---

## Files touched

| File | Changes |
|------|--------|
| `packages/cli/src/config.ts` | +2 (apiHost) |
| `packages/cli/src/daemon.ts` | +7 −1 (bind apiHost, log URLs) |
| `packages/node-ui/src/ui/pages/Explorer.tsx` | +359 −56 (filters, details panel, layout) |
| `packages/node-ui/src/ui/pages/Messages.tsx` | +36 −1 (OnlineIndicator, status in header) |
| `packages/node-ui/src/ui/styles.css` | +278 (new classes for Messages + Explorer) |

---

## Merge notes

- **Conflicts:** Possible in `config.ts` if `main` has added or reordered options. `daemon.ts` may conflict if `main` changed the same `listen`/log block. Resolve by keeping both `apiHost` and any newer options/logic.
- **Dependencies:** No new dependencies; uses existing hooks, API, and graph-viz.
- **Backend:** No backend API changes; uses existing `/api/agents` (with connectionStatus/connectionTransport) and `/api/query` (CONSTRUCT with optional `GRAPH`).

---

## How to merge (when ready)

```bash
cd /Users/aleatoric/dev/dkg-v9

# Optional: do this on a clean tree (commit or stash your work first)
git status

# Merge the branch into current branch (e.g. main)
git merge feat/dashboard-enhancements -m "Merge feat/dashboard-enhancements: dashboard enhancements - online status & graph filters"

# If there are conflicts, resolve in:
#   packages/cli/src/config.ts
#   packages/cli/src/daemon.ts
# then:
git add .
git commit -m "Merge feat/dashboard-enhancements (resolved conflicts)"
```

To merge into a separate integration branch:

```bash
git checkout -b merge/dashboard-enhancements main
git merge feat/dashboard-enhancements -m "Merge feat/dashboard-enhancements: dashboard enhancements"
```
