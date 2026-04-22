# DKG V10 OpenClaw Adapter

`@origintrail-official/dkg-adapter-openclaw` connects a local OpenClaw agent to a DKG V10 node.

The adapter is a thin bridge into the DKG node. It does not run its own DKG node. The DKG daemon owns the node, triple store, P2P networking, `/.well-known/skill.md`, the right-side UI chat surface, and DKG-backed chat and memory persistence.

## What It Does

- bridges the DKG node UI to a local OpenClaw agent
- keeps connected-agent chat persisted in DKG Working Memory via the `chat-turns` assertion of the `agent-context` context graph
- registers the DKG memory provider as OpenClaw's memory-slot capability, so slot-backed recall reads flow through real V10 primitives (assertion-scoped SPARQL queries with `view: 'working-memory'`, `'shared-working-memory'`, and `'verified-memory'`) rather than the legacy filesystem-watcher path
- exposes DKG agent-network tools to the OpenClaw runtime

Memory writes are not exposed as an adapter tool. The agent persists memory through direct daemon routes listed in `packages/cli/skills/dkg-node/SKILL.md` §5 (`POST /api/assertion/create` on first use of a fresh project CG, then `POST /api/assertion/:name/write` for each write). The daemon serves the skill document at `GET /.well-known/skill.md`, so the agent sees it on startup and calls the routes directly.

## What It Does Not Do Anymore

- it is not the source of truth for `SKILL.md`
- it does not copy workspace skill files during setup
- it does not enable OriginTrail Game behavior in the default OpenClaw path
- it does not try to be the product-level owner of the DKG install and UI experience

## Quick Start

Install the DKG CLI and run setup:

```bash
npm install -g @origintrail-official/dkg
dkg openclaw setup
```

The setup flow is non-interactive and idempotent. It writes `~/.dkg/config.json`, merges the adapter into `~/.openclaw/openclaw.json` (including the adapter's runtime config under `plugins.entries.adapter-openclaw.config`), starts the daemon if requested, and verifies the node.

The node UI's right-panel "Connect OpenClaw" button runs this same setup flow in-process — clicking it from a fresh install is equivalent to running `dkg openclaw setup` on the command line (issue #198).

If the OpenClaw gateway does not auto-reload after the config change, run:

```bash
openclaw gateway restart
```

## Verification

A healthy setup should satisfy all of the following:

- `dkg_status` works from the OpenClaw agent
- the DKG node UI loads at `http://127.0.0.1:9200/ui`
- the right-side chat surface can connect to OpenClaw and send a message successfully
- the conversation survives UI reload because the turns are persisted in DKG memory

## Config Files

| File | Owner | Purpose |
| --- | --- | --- |
| `~/.dkg/config.json` | DKG node | node config: networking, chain, auth, API |
| `~/.openclaw/openclaw.json` | OpenClaw | plugin loading config; the adapter's runtime config also lives here under `plugins.entries.adapter-openclaw.config` |

## Adapter Config

These keys live under `plugins.entries.adapter-openclaw.config` in `~/.openclaw/openclaw.json`. `dkg openclaw setup` populates them with first-wins semantics — customizations survive re-runs unless `--port` is passed explicitly (which refreshes `daemonUrl`).

| Key | Default | Purpose |
| --- | --- | --- |
| `daemonUrl` | `http://127.0.0.1:9200` | DKG daemon HTTP URL (env `DKG_DAEMON_URL` overrides at runtime) |
| `memory.enabled` | `true` after setup | register the DKG memory-slot capability on attach (slot-backed recall via `api.registerMemoryCapability`; no adapter-side write tool — writes go through SKILL.md direct routes) |
| `channel.enabled` | `true` after setup | enable the DKG UI to OpenClaw bridge |
| `channel.port` | `9201` (optional) | standalone bridge port when gateway route registration is unavailable; setup does not write this key — set it manually on the entry config if you need to override the default |

**Disconnect semantics.** The node UI's "Disconnect" button removes `plugins.entries.adapter-openclaw` entirely from `~/.openclaw/openclaw.json` (including any customized `config` values) AND removes `$WORKSPACE_DIR/skills/dkg-node/SKILL.md` (the canonical DKG node skill installed by setup). Other skills under `skills/` and sibling files under `skills/dkg-node/` are untouched. If you had set a non-default `daemonUrl` (for example via `dkg openclaw setup --port 9300` or a remote daemon URL), re-run `dkg openclaw setup --port <N>` after Reconnect to restore it — Reconnect also re-installs the skill document. Default-port users see no visible difference across a Disconnect/Reconnect cycle aside from the brief absence of the skill file.

Memory flows exclusively through `api.registerMemoryCapability` for slot-backed recall reads (handled by `DkgMemorySearchManager`, which fans out four parallel SPARQL queries — one against `agent-context` / `chat-turns` in working memory plus three against the resolved project CG's `memory` assertion with `view: 'working-memory'`, `'shared-working-memory'`, and `'verified-memory'` — and ranks the merged results with a trust-weighted score) and through the daemon routes documented in `packages/cli/skills/dkg-node/SKILL.md` for writes (`POST /api/assertion/create` on the first write to a fresh project CG, then `POST /api/assertion/:name/write` for each write after that).

## Notes

- The DKG node serves the canonical `SKILL.md` at `GET /.well-known/skill.md`.
- Connected-agent chat in DKG V10 belongs in the right-side shell chat surface, not the legacy Agent Hub tab.
- The adapter package includes a lightweight `setup-entry.mjs` so newer OpenClaw setup/runtime flows can load setup-safe surfaces separately from the full runtime.
