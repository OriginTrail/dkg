# ADR 0007 — Prime Agent chat transport is an extension-hosted loopback HTTP bridge

- **Status:** Proposed
- **Date:** 2026-08-06
- **Deciders:** DKG core maintainers (pending)
- **Supersedes:** —
- **Affected modules:** `packages/adapter-prime-agent/*` (new),
  `packages/cli/src/daemon/prime-agent.ts` (new),
  `packages/cli/src/daemon/routes/prime-agent.ts` (new),
  `packages/cli/src/daemon/local-agents.ts`,
  `packages/cli/src/daemon/routes/local-agents.ts`,
  `packages/node-ui/src/ui/components/Shell/PanelRight/ConnectedAgentsTab.tsx`
- **Refs:** `OriginTrail/dkg@843f5213`, `PrimeIntellect-ai/prime-agent@0e0d2339`

## Context

`packages/adapter-hermes` collocates a Hermes agent by forwarding Node UI
right-panel chat from the DKG daemon to Hermes' OpenAI-compatible HTTP server on
`127.0.0.1:8642`, streaming the reply back as SSE and persisting turns via
`POST /api/hermes-channel/persist-turn`.

Prime Agent has no such server. A repo-wide search at `0e0d2339` finds only
`node:net` unix sockets — the daemon supervisor
(`packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:662,731`) and the
IPython kernel fork server (`src/core/kernel/fork-server.ts:130,172`) — plus
ephemeral OAuth loopback receivers (`packages/ai/src/utils/oauth/*`,
`packages/ai/src/mcp/oauth.ts`). No HTTP framework appears in any workspace
`package.json`.

We must therefore choose how the daemon reaches a **running** Prime Agent
session. "Running" is load-bearing: collocation means the user's live session,
with its context and kernel, not a fresh one spawned per message.

## Decision

**The adapter ships a Prime Agent extension that hosts a loopback HTTP server
implementing `/health`, `/send` and `/stream`** — the same contract the DKG
daemon already speaks for Hermes bridge targets.

- Inbound: `POST /send` → `pi.sendUserMessage(content, { deliverAs: "followUp" })`
  (`src/core/extensions/types.ts:1135-1138`).
- Outbound: `POST /stream` → SSE frames `data: <json>\n\n` fed by
  `pi.on("message_update")`, whose payload carries `assistantMessageEvent`, the
  token-by-token stream event (`types.ts:683`; `docs/extensions.md:541-544`).
- Liveness: `GET /health` returns `{ ok: true }`, which is what
  `probeHermesChannelHealth` and the stricter `ensureHermesBridgeAvailable`
  require (`packages/cli/src/daemon/hermes.ts:494`, `:565`).
- Auth: `x-dkg-bridge-token`, verified in the extension, sent by the daemon only
  for loopback bridge targets (`hermes.ts:269-276`).

## Rationale

1. **It is the only option that attaches to a running session without adopting a
   self-disclaimed protocol.** Extensions are `jiti`-imported into the process
   that owns execution — the daemon *worker* for a resident session
   (`src/core/extensions/loader.ts:331-351`; `docs/daemon.md:23-27`).
2. **Extensions have unrestricted Node access**, so an HTTP listener is
   uncontroversial: *"Extensions run with your full system permissions and can
   execute arbitrary code"* (`docs/extensions.md:110`); *"Node.js built-ins …
   are also available"* (`:153`). The loader has no allowlist.
3. **In-tree precedent exists for the exact pattern.**
   `examples/extensions/file-trigger.ts:1-9` describes itself as *"Useful for
   external systems to send messages to the agent"* and injects via
   `pi.sendMessage({...}, { triggerTurn: true })` (`:18-34`).
4. **Near-zero new daemon design.** Target derivation
   (`hermes.ts:211-222`), pre-send gating (`:529-537`), header scoping
   (`:269-276`) and SSE passthrough with backpressure (`:781-786`) are reused
   with the names changed.
5. **Lowest coupling to upstream churn.** It depends on the documented extension
   API, not on the daemon wire protocol.

## Alternatives considered

| Option | Attaches to a running session? | Fatal objection |
| --- | --- | --- |
| **(b) `--mode rpc`** | **No** | Routes through `createDaemonClientConnection({ clientOwned: true })` (`src/main.ts:1512-1519`); the reuse branch is gated `&& !options.clientOwned` (`:968`), so it always creates a `lifecycle: "client_owned"` session (`:983-991`). Aiming it at a live session file yields `SessionAlreadyActiveError` (`:1520-1526`). The UI would talk to an empty second agent. |
| **(c) `--mode acp`** | **No** | Same spawn path, plus `loadSession: false` (`src/modes/acp/acp-mode.ts:261`) and a hard refusal of a second `session/new` per connection (`:279-284`). |
| **(d) Daemon unix socket** | **Yes** | Self-disclaimed: *"not the final remote gateway protocol"* (`src/modes/daemon/daemon-protocol.ts:42-49`), *"not promises of a stable public network schema"* (`docs/agent-connection.md:85`). **No in-protocol auth** — `authenticated: true` unconditionally (`daemon-supervisor.ts:1011`); security is only a `0700` dir + `0600` socket (`daemon-socket.ts:7-8,233-235`) and the docs call it *"not a sandbox boundary"* (`docs/daemon.md:120`). CLI entry points were **removed** at this SHA (`src/cli/command-registry.ts:159`), so `runPrompt`/`runJsonAttach` (`src/cli/daemon-command.ts:807-860`) are unreachable. Incremental replay is near-always `event_replay_not_available` (`daemon-protocol.ts:1132-1139`). Version already moved 4→7 with 13 schema revisions (`:52-60`) while docs still say v4 (`docs/daemon.md:76`). |
| **(e) SDK `createAgentSession`** | **No** (in-process only) | Constructs auth, models, settings, sessions and MCP locally with no transport parameter (`src/core/sdk.ts:155-185`); *"Direct SDK calls … remain in-process"* (`docs/daemon.md:55`); process-local extension factories force-disable the daemon path (`src/main.ts:234`). Would make the DKG daemon the agent host, violating the adapter boundary. |

## Consequences

**Positive**

- Real collocation semantics: messages land in the session the user is using.
- Reuses the daemon's existing bridge machinery, guards and SSE plumbing.
- Upstream-churn exposure limited to `pi.on`, `pi.sendUserMessage` and the
  extension lifecycle events.

**Negative / accepted costs**

- **Per-session ports.** Extensions load per session, so each resident worker
  binds its own listener. Resolved by a discovery directory
  `~/.prime/agent/.dkg-adapter-prime-agent/sessions/<sessionId>.json` written on
  `session_start` and removed on `session_shutdown` (`types.ts:514,553`;
  shutdown is awaited, `runner.ts:178-187`). Without a session live, there is no
  bridge — the daemon must degrade to `BRIDGE_OFFLINE` rather than spawn.
- We own an HTTP server inside someone else's process; it must bind `127.0.0.1`
  only and verify `x-dkg-bridge-token` with a timing-safe comparison (the
  OpenClaw reference uses `!==`, `packages/adapter-openclaw/src/DkgChannelPlugin.ts:2553-2570`).
- Two failure surfaces to report distinctly: extension not installed vs. no live
  session.

**Revisit when:** Prime Agent ships a supported local HTTP/gateway surface — the
protocol header explicitly anticipates *"a future gateway"*
(`daemon-protocol.ts:42-49`). At that point the bridge should be retired in its
favour, removing both the per-session port problem and our in-process listener.
