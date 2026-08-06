# `@origintrail-official/dkg-adapter-prime-agent`

Collocates a **Prime Intellect Prime Agent** with a DKG V10 node, the way
`adapter-hermes` collocates a Hermes agent.

**Status: Stage 1 — transport.** The bridge, discovery, setup lifecycle and
daemon plumbing are implemented and tested. Memory election hooks, the Python
kernel skill and the Node UI panel are staged (see
`agent-docs/adapters/prime-agent/IMPLEMENTATION-PLAN.md`).

Design: [`agent-docs/adapters/prime-agent/DESIGN.md`](../../agent-docs/adapters/prime-agent/DESIGN.md) ·
Transport decision: [`.ai/adr/0007`](../../.ai/adr/0007-prime-agent-adapter-transport.md) ·
Risks: [`RISKS.md`](../../agent-docs/adapters/prime-agent/RISKS.md)

## How it works

Prime Agent has **no HTTP server** and its daemon socket protocol disclaims
itself as *"not the final remote gateway protocol"*. What it does have is
extensions: TypeScript modules `jiti`-imported **into the process that owns a
running session**.

So the adapter ships an extension that hosts a small loopback HTTP bridge
speaking the contract the DKG daemon already speaks for Hermes:

| Route | Purpose |
| --- | --- |
| `GET /health` | `{ ok: true, sessionId, pid }` — `ok === true` is required by the daemon's probe |
| `POST /send` | injects via `pi.sendUserMessage`, returns `{ text, correlationId, sessionId }` |
| `POST /stream` | SSE, `data: <json>\n\n` frames of `delta` then `final` |

**`final` is terminal, and it is a contract.** The turn ends on that frame, not
on socket EOF — the bridge may keep its connection open afterwards, and it does.
Both the daemon proxy and the Node UI reader close on the frame; a client that
waits for EOF will spin forever over an answer it has already rendered. The
daemon also declares `Content-Type: text/event-stream; charset=utf-8` before the
first byte, without which the browser misclassifies the body and fails with
"The string did not match the expected pattern".

All three require `x-dkg-bridge-token` and bind `127.0.0.1` only.

Because the extension lives inside the session, a message from the Node UI lands
in **the session the user is actually using** — that is the whole point, and it
is what a spawned `--mode rpc` subprocess cannot do.

## Per-session bridges

Extensions load **per session**, and one worker hosts many concurrent sessions,
so there is no single well-known endpoint. Each session publishes a descriptor:

```
~/.prime/agent/.dkg-adapter-prime-agent/sessions/<sessionId>.json
{ "sessionId": "...", "bridgeUrl": "http://127.0.0.1:54123", "pid": 4242, "startedAt": "..." }
```

written on `session_start` and removed on `session_shutdown`. The daemon reads
that directory and prunes descriptors whose `pid` is gone.

Two details that are not incidental:

- **Ephemeral ports (`listen(0)`) are mandatory.** On `/reload`, `/new`,
  `/fork` and `/resume` the process survives and the extension is re-imported
  with `moduleCache: false`, so the successor has no reference to the old
  server. Nothing in the host closes extension-owned sockets, so a fixed port
  would be held by an orphan until process exit.
- **`/health` echoes its `sessionId`**, so the daemon can detect a descriptor
  pointing at a port the OS has since recycled to another process.

## Files it owns

| Path | Owner | Note |
| --- | --- | --- |
| `~/.prime/agent/settings.json` | **Prime Agent** | we add exactly one entry to `extensions` |
| `~/.prime/agent/settings.json.bak.<unix-ms>` | adapter | verbatim pre-change backup |
| `~/.prime/agent/.dkg-adapter-prime-agent/setup-state.json` | adapter | state + `priorSettings` snapshot |
| `~/.prime/agent/.dkg-adapter-prime-agent/dkg.json` | adapter | daemon URL, policy, and bridge token; mode `0600` |
| `~/.prime/agent/.dkg-adapter-prime-agent/sessions/` | adapter | per-session bridge discovery |

### Reversibility

The write order is the contract, copied from `adapter-hermes` because it is the
part that has to survive a SIGINT:

1. `setup-state.json` with `priorSettings` — **before** any destructive write
2. `settings.json.bak.<unix-ms>` — verbatim original bytes
3. `settings.json` rewritten with our extension path

`priorSettings` is **first-wins**: a re-run never overwrites the original truth.
Restore is **surgical** — it removes exactly our entry, because unlike Hermes'
scalar `memory.provider` this is an array the user may legitimately have edited;
wholesale replacement would silently revert their work. Backup-rename is the
fallback, and either path verifies the entry is really gone before reporting
success.

## Guards

`allow_direct_publish` and `allow_context_graph_admin_tools` default to
**false**, and `import_roots` defaults to empty. This is deliberately at least
as strict as Hermes: Prime Agent executes model-authored Python in a persistent
kernel with the user's own permissions and is explicitly **not a sandbox**, so a
publish path must be opened by an operator, never inferred.

The bridge verifies `x-dkg-bridge-token` with a **timing-safe** comparison, and
returns `503` (not `401`) when no token has been provisioned at all — an
unauthenticated bridge would let anything on loopback drive the agent.
Setup sources that token from `DKG_API_TOKEN`, `DKG_AUTH_TOKEN`, or the selected
DKG home's `auth.token`, then writes the private adapter config consumed by the
extension.

## Known limits (Stage 1)

- Memory election hooks (`before_agent_start`, `turn_end`) are **not yet wired**
  and the integration does not advertise primary-memory capability yet.
- No Python kernel skill yet (Stage 3), so there is no model-facing `dkg` API.
- The Node UI panel is live (Stage 5) but has **no session picker**: the node
  routes to the newest live session unless a `sessionId` is supplied.
- One turn at a time per session: a concurrent `/send` gets `429`.
- A UI message is sent as `deliverAs: "followUp"`. If a local Prime Agent turn
  is already observed, the bridge returns `429`; the follow-up choice covers the
  remaining race without interrupting local work.

## Tests

```bash
pnpm --filter @origintrail-official/dkg-adapter-prime-agent test
```

`test/bridge-contract.test.ts` drives the bridge with a stub `pi` and **no Prime
Agent running**, so it asserts our half of the wire independently of upstream —
including the 401/503 auth split, the `ok === true` health shape, SSE frame
format, and the 429 concurrency guard.
