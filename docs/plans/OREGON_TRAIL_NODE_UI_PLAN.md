# Oregon Trail in Node UI — Implementation Plan

**Status:** Draft  
**Depends on:** Oregon Trail game logic (OregonTrailV9), DKG V9 node (workspace, context graphs with M/N attestation), Context Oracle (optional, for verified reads)  
**Target:** `@dkg/node-ui` and daemon (`packages/cli`) so users can play Oregon Trail from their DKG Node dashboard. Each player runs their own node; coordination is via the DKG (workspace + context graph).

---

## 1) Goal

Integrate **Oregon Trail** (multiplayer wagon-train game on the DKG) into the Node UI so that:

- Each player runs **one node** and plays from the **Node UI** in their browser (on the machine where that node runs).
- **1 wagon = 1 game = 1 context graph** on the Oregon Trail paranet. The context graph holds the attested game state and grows with each turn.
- **Minimum 3 players** per wagon (more allowed). Players **vote** on the next action (travel, hunt, rest, ford, ferry); votes are exchanged through the **workspace** between nodes.
- To **advance the game**, the **game master** (one of the players) proposes a new entry in the context graph; **at least floor(2/3 × N) nodes must sign** for the entry to be committed on-chain. The game master cannot advance without consensus.
- Lobby, wagon create/join, voting, and turn flow are available in-browser; game state is read from the context graph and votes from the workspace via the local node’s API.

---

## 2) Concepts (aligned with sequence diagram)

| Concept | DKG / Node UI |
|--------|----------------|
| **Oregon Trail** | Multiplayer game: 1 wagon = 1 game = 1 context graph. Turns = rounds; votes = travel/hunt/rest/ford/ferry. Votes live in **workspace**; committed state lives in **context graph**. |
| **Context Graph** | On-chain M/N signature-gated subgraph in a paranet. URI: `did:dkg:paranet:{paranetId}/context/{contextGraphId}`. One context graph per wagon; participants = wagon members; **floor(2/3 × N)** signatures required to append a new entry (next game state). |
| **Workspace** | DKG workspace on the Oregon Trail paranet. Used to publish and sync **votes** so all nodes see each other’s votes before the game master proposes the next context-graph entry. |
| **Game master** | One of the players (e.g. wagon creator or rotating). Computes next state from votes (e.g. majority), builds the new context-graph entry, and collects signatures from other nodes until ≥ floor(2/3 × N); then commits on-chain. |
| **Context Oracle** (optional) | Read API that returns triples from a context graph **with Merkle inclusion proofs**. Enables trustless verification of game state in the UI. |

---

## 3) Architecture Overview

- **Multi-node:** Each player runs a node (daemon + Node UI). There is no single “game server”; coordination is through the DKG (workspace + context graph).
- **Lobby:** “Open wagons” = list of context graphs on the Oregon Trail paranet that represent wagons (e.g. by descriptor type or `rdf:type`). Create wagon = create new context graph (min 3 members). Join wagon = join existing context graph.
- **Vote phase:** Each player submits a vote from their UI → local node publishes vote to **workspace**. All nodes see votes via workspace sync.
- **Advance phase:** Game master’s node runs the reducer (votes → next state), proposes a new **context graph entry**. Other nodes verify and sign; when **floor(2/3 × N)** signatures are collected, the entry is committed to the context graph **on-chain**. All nodes then read the updated state from the context graph.

```
┌─────────────────────────────────────────────────────────────────┐
│  Node UI (Browser) — per player, on their machine                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐   │
│  │ Dashboard   │  │ Explorer   │  │ Oregon Trail (new)      │   │
│  │ ...         │  │ ...        │  │  • Lobby / wagons       │   │
│  └─────────────┘  └─────────────┘  │  • Create / join wagon │   │
│                                     │  • Vote (→ workspace)  │   │
│                                     │  • Sign / propose (CG) │   │
│                                     └──────────┬──────────────┘   │
└────────────────────────────────────────────────┼─────────────────┘
                                                  │ /api/oregon-trail/*
┌─────────────────────────────────────────────────┼─────────────────┐
│  Daemon (this node)                              ▼                 │
│  • GET  /api/oregon-trail/lobby        → list wagons (context graphs) │
│  • POST /api/oregon-trail/create       → create wagon = new CG (min 3) │
│  • POST /api/oregon-trail/join         → join wagon (existing CG)  │
│  • GET  /api/oregon-trail/wagon/:id    → wagon state from CG       │
│  • POST /api/oregon-trail/vote         → publish vote to workspace │
│  • POST /api/oregon-trail/propose      → (GM) propose new CG entry  │
│  • POST /api/oregon-trail/sign         → sign proposed CG entry    │
│  Uses: workspace publish/query, context graph read/write + attestation │
└───────────────────────────────────────────────────────────────────┘
                          │
                          │ workspace (votes) / context graph (state)
                          ▼
┌───────────────────────────────────────────────────────────────────┐
│  DKG Oregon Trail paranet — shared by all players’ nodes          │
│  Workspace: votes per turn.  Context graphs: one per wagon.        │
└───────────────────────────────────────────────────────────────────┘
```

---

## 4) Implementation Phases

### Phase 1 — Backend: Oregon Trail API on the daemon

**Owner:** `packages/cli` (daemon) + shared types/helpers (e.g. under `packages/node-ui` or `packages/oregon-trail`).

1. **Oregon Trail API routes**
   - **`GET /api/oregon-trail/lobby`**  
     Returns open wagons (context graphs on the Oregon Trail paranet that represent wagons). Implementation: query paranet for context graph descriptors with type “wagon” (or equivalent); include member count, status, CG id.
   - **`POST /api/oregon-trail/create`**  
     Body: `{ playerId, playerName, ... }`.  
     Creates wagon = **create new context graph** on the paranet with **minimum 3 participants** (this node + at least 2 others to be added via join). Publish descriptor and initial state; store wagon id (context graph id) for redirect.
   - **`POST /api/oregon-trail/join`**  
     Body: `{ wagonId (CG id), playerId, playerName }`.  
     Join wagon = join the existing context graph (add this node as participant). Publish join event / update membership as required by context graph semantics.
   - **`GET /api/oregon-trail/wagon/:wagonId`**  
     Returns current wagon state (miles, food, party, turn, phase).  
     Implementation: **read from context graph** `did:dkg:paranet:dkg-trail/context/{wagonId}` (or equivalent). No single “local store” of authority; state is the latest attested entry in the CG.
   - **`POST /api/oregon-trail/vote`**  
     Body: `{ wagonId, playerId, voteAction, params?, turn? }`.  
     **Publish vote to workspace** (paranet). All nodes see votes via workspace sync. No resolution inside this call; resolution is done when the game master proposes a new CG entry.
   - **`POST /api/oregon-trail/propose`** (game master only)  
     Body: `{ wagonId, turn, nextState }`.  
     Game master’s node: compute next state from votes (reducer from OregonTrailV9), build **new context graph entry**, and initiate attestation. Entry is **not** committed until enough signatures are collected.
   - **`POST /api/oregon-trail/sign`**  
     Body: `{ wagonId, entryIdOrPayload }`.  
     Another node verifies the proposed entry (state transition is valid given votes) and **signs** the context graph entry. When **≥ floor(2/3 × N)** nodes have signed, the daemon (or attestation service) **commits the entry on-chain** and the context graph grows by one step.

2. **Attestation and context graph writes**
   - Use existing (or add) M-of-N attestation flow for context graph appends: propose → collect signatures → commit when threshold **floor(2/3 × N)** is met. N = number of participants in the wagon (context graph).

3. **Real-time updates (optional but recommended)**
   - Expose **SSE** (e.g. `GET /api/gossip/stream?topic=oregon-trail/turns` or workspace subscription) so the UI gets notified when: new votes appear, a new entry is proposed, entry is committed. Reduces polling on wagon state and vote list.

4. **Game engine / reducer**
   - Reuse or port from OregonTrailV9: deterministic **reducer (prevState, votes) → nextState**. Run on the **game master’s node** when building the proposed CG entry. Other nodes may run the same reducer to **verify** the proposed next state before signing.

**Deliverables**
- Daemon implements lobby, create, join, wagon state (from CG), vote (workspace), propose (GM), sign (participants), and floor(2/3×N) commit for context graph entries.
- Wagons are context graphs; votes are in workspace; game advances only when the GM proposes and ≥ floor(2/3×N) nodes sign.

---

### Phase 2 — Frontend: Oregon Trail page in Node UI

**Owner:** `packages/node-ui`.

1. **Route and nav**
   - Sidebar link “Oregon Trail”; route `/oregon-trail`. New page: `OregonTrailPage.tsx`.

2. **Lobby view**
   - `GET /api/oregon-trail/lobby`. List open wagons (id, player count, status). Buttons: “Create wagon”, “Join” per wagon. Clarify that **creating requires at least 3 players** (e.g. “Create wagon” then others “Join” until 3+).

3. **Create / join flow**
   - Create: form (player name, etc.) → `POST /api/oregon-trail/create` → redirect to wagon view (user is GM for that wagon until/unless rotated).
   - Join: select wagon → `POST /api/oregon-trail/join` → redirect to wagon view.

4. **Wagon view**
   - `GET /api/oregon-trail/wagon/:wagonId` for state (from context graph). Display: trail progress, party, resources, current turn and phase (e.g. “Vote” vs “Waiting for signatures” vs “Turn resolved”).

5. **Voting UI**
   - During vote phase: travel / hunt / rest / ford / ferry (and params). Submit → `POST /api/oregon-trail/vote` (vote goes to workspace). Show “Waiting for others” until GM proposes and then “Waiting for signatures” or “Turn resolved”.

6. **Game master flow (when this node is GM)**
   - When all votes are in (or timeout), show “Propose next turn” (or auto-propose). On confirm, `POST /api/oregon-trail/propose`. Then other nodes see the proposed entry and can sign via `POST /api/oregon-trail/sign` (or daemon does it when user opens wagon view and entry is valid).

7. **Sign / attestation (when this node is not GM)**
   - When a proposed entry exists, show “Proposed next state” and a “Sign” (or “Approve”) button → `POST /api/oregon-trail/sign`. After enough signatures, entry commits and all UIs refresh from CG.

8. **Real-time updates**
   - Subscribe to SSE (or workspace events) for new votes, proposed entry, and entry committed so the UI updates without full page refresh.

9. **Leave / end**
   - Optional: “Leave wagon” (only when allowed by game rules), “End game” (if supported and this node is GM).

**Deliverables**
- Oregon Trail page with lobby, create/join, wagon view, voting (workspace), propose (GM), sign (participants), and live updates. No separate game server; each player uses their own node and UI.

---

### Phase 3 (optional) — Context Oracle for verified reads

**Owner:** daemon + publisher (Context Oracle) + Node UI.

- Wagons are **already** context graphs; this phase adds **verified reads** via Context Oracle.
- **Daemon:** Expose `GET /api/context-graphs?paranetId=dkg-trail`, and oracle endpoints (e.g. entity/query with proofs) for a given context graph id.
- **Node UI:** In wagon view, optional “Verify” or “Verified by on-chain root” using oracle responses and client-side proof verification.

**Deliverables**
- Same game flow as Phase 1–2, with optional UI to show that wagon state is verified against the on-chain context graph root.

---

## 5) Data and naming

- **Paranet:** e.g. `dkg-trail` (Oregon Trail paranet).
- **Context graph:** One per wagon. URI `did:dkg:paranet:dkg-trail/context/{contextGraphId}`. Descriptor in `_meta` graph; participants = wagon members; **M = floor(2/3 × N)** for appending entries.
- **Workspace:** Same paranet. Votes (wagonId, turn, playerId, action, params) published so all nodes can read them; GM uses votes to compute next state and propose CG entry.
- **Ontology:** Reuse Oregon Trail RDF types from OregonTrailV9 (e.g. wagon state triples, vote triples). Use existing context graph naming (`contextGraphDataUri`, `contextGraphMetaUri`) where applicable.

---

## 6) Where Oregon Trail code lives and how the frontend loads

**Split of responsibilities**

| Layer | Location | Contents |
|-------|----------|----------|
| **App logic (backend + shared)** | **`packages/oregon-trail`** (new package) | Types (`WagonState`, `VoteAction`, `ProposedEntry`), reducer / game engine (from OregonTrailV9), constants (paranet id, threshold). Optionally: **API handler** — a function the daemon can call to handle `/api/oregon-trail/*` (so route logic lives with the app, not in the daemon). |
| **API routes** | **`packages/cli`** (daemon) | Mounts Oregon Trail API: either imports handlers from `@dkg/oregon-trail` and registers them, or defines routes in `oregon-trail-api.ts` that call into `@dkg/oregon-trail` for logic. |
| **Frontend (UI)** | **`packages/node-ui`** | Oregon Trail as one more **route** in the existing Node UI app: `src/ui/pages/OregonTrailPage.tsx`, subviews under `src/ui/pages/oregon-trail/`, API helpers in `api.ts`. Imports types (and optionally helpers) from `@dkg/oregon-trail`. |

**How the frontend gets loaded**

- The Node UI is a **single Vite app** (one bundle). It is built once (`pnpm build:ui` in `@dkg/node-ui`) and served by the daemon at `/ui` (static dir: `node-ui/dist-ui`).
- Oregon Trail does **not** ship as a separate app or iframe. It is a **route and set of components** inside the same SPA: path `/oregon-trail`, sidebar link “Oregon Trail”. Adding it = adding a `<Route>` and a `<NavLink>` in `App.tsx` (or in a central app registry — see below). No extra “loading” step: it’s part of the same bundle.

---

## 7) Installable apps: no approval required (preferred pattern)

Contributors should **not** need maintainer approval to create new games or apps. The preferred approach is **installable DKG apps**: an app is a **standalone package** in the author's own repo; node runners **install** it (e.g. `pnpm add dkg-app-oregon-trail` or from GitHub), and the app appears in the Node UI and its API is served by the daemon — **without any edits to `packages/cli` or `packages/node-ui`**.

See **[DKG_APPS_INSTALLABLE.md](./DKG_APPS_INSTALLABLE.md)** for the full design. Summary:

- **Core (one-time only):** The daemon gets a generic **app loader**: discover installed app packages (from config or `node_modules` convention), load their API handler, serve their static UI at `/apps/:appId/*`. The Node UI gets a generic **Apps** section: fetch `GET /api/apps`, show links to each app; clicking an app opens it at `/apps/:appId/` (served by the daemon from the app's built UI). No per-app code in cli or node-ui.
- **App author:** Builds one package (their repo) with: (1) a **manifest** (`dkgApp` in `package.json` or `dkg-app.json`): `id`, `label`, `apiHandler`, `staticDir`; (2) an **API handler** that the daemon loads and invokes for `/api/apps/:id/*`; (3) a **built UI** (e.g. Vite app to `dist-ui`) that the daemon serves at `/apps/:id/`. Publish to npm or GitHub.
- **Node runner:** Installs the app package, adds it to `config.apps` (if not auto-discovered), restarts the node. The app shows up in the sidebar and works. No PR to the core repo.

Oregon Trail can be implemented as such an installable app (e.g. `dkg-app-oregon-trail` in its own repo). The same app can optionally be **shipped as a default installed app** in the core distro (listed in default config) so it appears out of the box — still no special-case code in node-ui or cli, just a default app entry.

---

## 8) File and package layout (concrete)

**Installable app (preferred, no core edits):**

- **Author's repo** (e.g. `dkg-app-oregon-trail`): `package.json` with `dkgApp` manifest; `src/handler.ts` (API handler); `ui/` (Vite app) build to `dist-ui/`; types, reducer (from OregonTrailV9), constants. Daemon discovers and loads it; Node UI shows it via generic Apps list.

**If built into monorepo instead:**

- **`packages/oregon-trail`**: Types, reducer, constants; optional API handler export.
- **Daemon:** Registers handler via generic app loader (no Oregon Trail-specific code).
- **Node UI:** No Oregon Trail-specific code if using installable pattern; otherwise a page + subviews and an entry in a static app list.

---

## 9) Testing and rollout

- **Unit:** Reducer and turn resolution (OregonTrailV9); threshold floor(2/3×N) for N=3,4,5,6.
- **Integration:** One node: create wagon (CG), join (second node), vote (workspace), propose (GM), sign (other node), assert context graph entry committed and state updated.
- **Multi-node:** 3+ nodes (or 3+ participants), full flow: create, join, votes, propose, collect floor(2/3×N) signatures, commit; assert all nodes see same state from CG.
- **Rollout:** Feature-flag or sidebar link when Oregon Trail paranet (e.g. `dkg-trail`) is enabled.

---

## 10) Summary

| Phase | Scope | Context Graph | Workspace | Attestation |
|-------|--------|---------------|-----------|-------------|
| **1** | Oregon Trail API: lobby, create/join (CG), wagon state (CG), vote (workspace), propose + sign (floor(2/3×N) → commit) | Yes (1 wagon = 1 CG) | Yes (votes) | floor(2/3×N) |
| **2** | Oregon Trail page in Node UI: lobby, wagon view, voting, propose (GM), sign (participants), live updates | — | — | — |
| **3** (optional) | Context Oracle API + UI verified reads | — | — | — |

Phases 1 and 2 implement the model from the sequence diagram: each player runs a node and plays from their UI; 1 wagon = 1 game = 1 context graph; votes via workspace; game master proposes new CG entry; at least floor(2/3 × N) nodes sign to commit on-chain; game grows the context graph and cannot advance without consensus.
