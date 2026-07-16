# Two-laptop coding demo on testnet

Two laptops, two operators, one project. Both wire Cursor to the same DKG context graph and code together — chat turns, decisions, and tasks are shared via the graph.

This is a pre-npm walkthrough: today both laptops bootstrap the daemon from a `dkg-v9` checkout on the `feat/cursor-dkg-integration` branch. Once the npm package ships the same flow becomes `npm install -g @origintrail-official/dkg && dkg start`.

## Prerequisites

On both laptops:

- **Node.js 22+** and **pnpm 10+**
- **Cursor** installed
- **Base Sepolia ETH** for the daemon's identity registration. Use the [DKG testnet faucet guide](setup/TESTNET_FAUCET.md). You'll need a few cents worth of testnet ETH per node.

## 1. Bootstrap (both laptops)

```bash
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
git checkout feat/cursor-dkg-integration
pnpm install
pnpm build
pnpm dkg init    # creates ~/.dkg with default testnet config
pnpm dkg start   # starts the daemon
```

Watch for the line `Network config: DKG V10 Testnet (genesis v1)` in the log. The daemon is now reachable at `http://localhost:9200`.

Open `http://localhost:9200/ui` in a browser. You should see the empty Node UI, the operator's identity address in the header, and "0 projects" on the dashboard.

> Troubleshooting: if `pnpm dkg start` complains about `Insufficient TRAC` or `identity not registered`, you need to fund the agent address shown in `pnpm dkg show` from the faucet, then re-run.

## 2. Laptop A: create the project

In Laptop A's Node UI, click **+ Create Project**. Fill in:

- **Project Name:** `Tic Tac Toe`
- **Description:** `Build a Tic Tac Toe game in TypeScript with React frontend and a minimax AI opponent`
- **Access:** `Curated` (recommended — Laptop A controls who joins)
- **Ontology:** `Choose a starter` → `Coding project`

Click **Create Project**. The modal walks through:

1. Registering the CG on Base Sepolia (~10–30s on testnet)
2. Installing the `coding-project` ontology into `meta/project-ontology`
3. Publishing the project manifest into `meta/project-manifest`
4. Transitioning into the **Wire workspace** step

In the Wire workspace step:

- **Workspace path:** e.g. `/Users/<you>/code/tic-tac-toe` (or whatever absolute path you want; the daemon creates the directory if it doesn't exist)
- **Agent slug for this machine:** something descriptive, e.g. `cursor-alice-laptop1`
- **Skip Claude Code wiring:** leave checked unless you actually use Claude Code

Click **Preview install**. The modal shows the markdown diff: which files will be created, sizes, where the daemon-token reference lands, and the security boundaries that are enforced (path-locked allowlist, no script execution, no tokens in the manifest). Review, then click **Install**.

You should see something like:

```
created   /Users/alice/code/tic-tac-toe/.cursor/rules/dkg-annotate.mdc (4,210 bytes)
created   /Users/alice/code/tic-tac-toe/.cursor/hooks.json (590 bytes)
created   /Users/alice/code/tic-tac-toe/.cursor/mcp.json (310 bytes)
created   /Users/alice/code/tic-tac-toe/.dkg/config.yaml (290 bytes)
created   /Users/alice/code/tic-tac-toe/AGENTS.md (12,400 bytes)
```

Click **Done**. The modal closes and Laptop A's UI shows the new project tab.

> Verify in the UI: click into the project, then `meta` sub-graph. You should see the manifest entity (`urn:dkg:project:.../manifest`), the ontology entity (`urn:dkg:project:.../ontology`), and the template entities for the Cursor rule, hooks, config, AGENTS.md.

## 3. Laptop A: plan the project from Cursor

Open the wired workspace in Cursor:

```bash
cursor /Users/alice/code/tic-tac-toe
```

Start a new chat and prompt:

> We're building a Tic Tac Toe game per the project description (TypeScript + React + minimax AI). Break it into 5–7 atomic tasks and create each one via `dkg_add_task`. Keep titles short and add a one-sentence description.

The agent has the `coding-project` ontology and the `dkg_add_task` tool from session-start context. It should produce something like:

- Set up Vite + React + TypeScript scaffold
- Build a 3x3 grid component with click-to-place
- Implement game-state reducer (current player, winner check, board state)
- Implement minimax AI for the computer player
- Wire up game-start / game-over UI states
- Write unit tests for the win-detection logic
- Polish UI (dark mode, animations, scoreboard)

Each task creates a `tasks:Task` entity in the project's `tasks` sub-graph and is auto-promoted to SWM (gossipped to all subscribed nodes).

> Verify: switch back to the Node UI, click into the project, then the `tasks` sub-graph. Each task should be there with its title, description, and a `prov:wasAttributedTo urn:dkg:agent:cursor-alice-laptop1` attribution.

## 4. Laptop A: share the invite

In the Node UI, open the project tab and click **Share Project**. Copy the invite code (it looks like `did:dkg:context-graph:0x.../tic-tac-toe` plus a `/ip4/.../p2p/12D3...` multiaddr on a second line) and send it to Laptop B over any channel — Signal, AirDrop, paper, whatever.

If you chose **Curated** access, you'll receive Laptop B's join request as a notification once they paste the invite (next step). Approve it from the project's Participants view.

## 5. Laptop B: join + wire

In Laptop B's Node UI, click **+ Join Project** and paste the invite code. The modal walks through:

1. Connecting to Laptop A's node (uses the multiaddr from the invite)
2. Subscribing to the project (and, if curated, sending a signed join request — wait for Laptop A to approve)
3. Catching up the project's existing knowledge: ontology, manifest, tasks, decisions, prior chat
4. Transitioning into the **Wire workspace** step

In the Wire workspace step:

- **Workspace path:** e.g. `/Users/<you>/code/tic-tac-toe` (a fresh local path on this machine)
- **Agent slug:** something distinct from Laptop A, e.g. `cursor-bob-laptop2`
- **Skip Claude Code:** as before

Preview, install, done. The wired workspace on Laptop B is identical in structure to Laptop A's; only the `agentSlug` and `daemonApiUrl` placeholders differ.

> Verify: in Laptop B's Node UI, the `tasks` sub-graph for this project shows the same 5–7 tasks Laptop A's agent created. The catchup pulled them across via gossip.

## 6. Both laptops: code together

Open the wired workspace in Cursor on each laptop and start a fresh chat. The session-start context the agent receives includes a bucketed plan, e.g.:

```
**Open tasks:**
- urn:dkg:tasks:set-up-vite-react — Set up Vite + React + TypeScript scaffold
- urn:dkg:tasks:build-grid-component — Build a 3x3 grid component with click-to-place
- urn:dkg:tasks:implement-game-state-reducer — Implement game-state reducer
- urn:dkg:tasks:implement-minimax-ai — Implement minimax AI for the computer player
- urn:dkg:tasks:wire-game-states — Wire up game-start / game-over UI states
- urn:dkg:tasks:test-win-detection — Write unit tests for the win-detection logic
- urn:dkg:tasks:polish-ui — Polish UI (dark mode, animations, scoreboard)

**Concepts in scope:**
- urn:dkg:concepts:minimax — Minimax algorithm
```

A natural opening prompt on Laptop B:

> I see we have these tasks. I'll start with `set-up-vite-react`. Use `dkg_annotate_turn` to record what I'm working on, and read any existing decisions on tech stack before scaffolding.

While Laptop B works on scaffolding, Laptop A could simultaneously pick a different task ("I'll take `implement-minimax-ai`"). Both agents emit `dkg_annotate_turn` calls that record what each turn examined / proposed / concluded. As tasks complete, agents call `dkg_add_task` again with `status: done` (or use a finer-grained mutation tool if you have one).

Switch back to either Node UI's **Activity feed** to watch chat turns, annotations, decisions, and task updates land in real-time from both laptops.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm dkg start` says "identity not registered" | Agent address has no Base Sepolia ETH yet | Fund the address shown in `pnpm dkg show` from the [faucet](setup/TESTNET_FAUCET.md), restart |
| `JoinProjectModal` shows "Access Restricted" | Curated CG, you're not on the allowlist | Click **Send Join Request**, ask the curator (Laptop A) to approve from their Participants view |
| `WireWorkspacePanel` preview fails with "No manifest published" | Curator created the project before this branch landed, or manifest publish failed silently | Curator runs `pnpm exec node scripts/import-manifest.mjs --project=<cgId>` from a wired workspace |
| Manifest install fails with "existing file is not valid JSON" | Operator already has a `.cursor/mcp.json` from another DKG project pointing at a different agent | Move the existing file aside, re-run install (the safety guard refuses to clobber an unparseable file) |
| Cursor agent doesn't see the tasks on Laptop B | Session-start hook didn't fire, or `.dkg/config.yaml` points at a different CG | Check `.dkg/capture-chat.log`. If empty, the hook isn't being invoked — verify `.cursor/hooks.json` exists and Cursor was restarted after wiring |
| Tasks created on Laptop A don't appear on Laptop B | Catchup completed before the tasks were published, OR libp2p connection dropped | On Laptop B, click **Sync** in the project view to re-pull. Verify both daemons show each other in `pnpm dkg peers` |
| `~/.claude/settings.json` got modified unexpectedly | Operator unchecked "Skip Claude Code wiring" | Restore `~/.claude/settings.json` from a backup; re-wire with skip-claude checked |

## What's deferred

These exist as code today but aren't part of the demo path. They become relevant once the project deepens:

- **`pnpm exec dkg-mcp join <invite>`** — the same wire flow as a CLI, useful for headless / CI / sshd setups. Same daemon endpoints, no UI required.
- **`scripts/import-manifest.mjs`** — re-publish a manifest if the templates drift (e.g. the curator updated `AGENTS.md` and wants the new copy to gossip).
- **`dkg-mcp sync`** — drift detection for already-wired workspaces. Will be the recommended way to refresh a workspace when the manifest version changes.

## Background

Phase 8 of `feat/cursor-dkg-integration` (PR #224) added the `dkg:ProjectManifest` schema, publish/install helpers, three daemon endpoints (`/api/context-graph/{id}/manifest/{publish|plan-install|install}`), and the `WireWorkspacePanel` shared by both modals. The architecture sketch lives in [packages/mcp-dkg/src/manifest/schema.ts](../packages/mcp-dkg/src/manifest/schema.ts); the security model (path-lock + safety guards) lives in [packages/mcp-dkg/src/manifest/install.ts](../packages/mcp-dkg/src/manifest/install.ts).
