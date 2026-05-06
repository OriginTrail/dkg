# Setting Up DKG V10 with Hermes Agent

This guide connects a Hermes profile to a local DKG V10 node. It reflects the
current release behavior: profile-aware DKG setup helpers, DKG as an optional Hermes
memory provider, and DKG daemon-owned local-agent routes under
`/api/hermes-channel/*`.

## Prerequisites

- Node.js 22+ and npm for packaged installs, or pnpm for this DKG monorepo.
- A DKG node configured with `dkg init` and running with `dkg start`.
- Hermes Agent installed on Linux, macOS, WSL2, or Termux.

Hermes does not support native Windows. On Windows, run Hermes inside WSL2. A
DKG daemon may still run on Windows, but the Hermes profile must use a daemon
URL that is reachable from WSL.

## Profile Paths

Hermes scopes profile state through `HERMES_HOME`.

| Target | Hermes home |
| --- | --- |
| default profile | `~/.hermes` |
| named profile | `~/.hermes/profiles/<profile>` |
| explicit `HERMES_HOME` | the exact path in `HERMES_HOME` |

DKG setup follows the same rule. For example:

```bash
dkg hermes setup --profile research
```

targets `~/.hermes/profiles/research`.

## DKG Memory Provider Setup

Use setup when DKG should be Hermes' active external memory provider.

```bash
dkg start
dkg hermes setup --profile research
dkg hermes verify --profile research
```

Setup writes only adapter-owned artifacts inside the selected Hermes profile:

- `dkg.json`
- `plugins/dkg`
- `.dkg-adapter-hermes/setup-state.json`
- a managed `memory.provider: dkg` block in `config.yaml`
- the bundled DKG node skill at `skills/dkg-node/SKILL.md`

`dkg.json` records the DKG home directory that matches the target daemon, so
Hermes uses the same `auth.token` as `pnpm dkg` in monorepo `.dkg-dev` and
packaged `.dkg` installs.

Provider facts are written to the `memory` assertion in `agent-context` by
default. The fact subjects still carry the Hermes profile/agent identity.

DKG is the intended memory provider for this adapter. Setup installs and selects
DKG by writing a managed `memory.provider: dkg` block. If the target profile
already has another provider configured, this release stops before changing it
so setup never silently replaces an existing memory backend. To switch that
profile to DKG, remove or change the existing `memory.provider` entry in
`config.yaml`, then rerun `dkg hermes setup`. For a clean start, use a fresh
Hermes profile.

## CLI Helpers

```bash
dkg hermes setup --profile research --dry-run
dkg hermes setup --profile research --gateway-url https://hermes.example.com
dkg hermes status --profile research
dkg hermes verify --profile research
dkg hermes doctor --profile research
dkg hermes disconnect --profile research
dkg hermes reconnect --profile research
dkg hermes uninstall --profile research
```

`status`, `verify`, and `doctor` inspect the profile path and setup-state
metadata. `disconnect` removes only the managed provider election block and
marks the DKG adapter disconnected. `uninstall` removes ownership-marked DKG
adapter artifacts and preserves user-owned Hermes data.

Lifecycle commands reuse persisted daemon and bridge settings from
`setup-state.json` when flags are omitted, so a profile configured with a
custom daemon URL or gateway does not fall back to localhost during
`disconnect`, `reconnect`, or `uninstall`.

## Local-Agent Chat

The DKG daemon exposes these Hermes-specific routes. They are supported daemon
routes, not standalone HTTP handlers exported by `packages/adapter-hermes`:

```text
GET  /api/hermes-channel/health
POST /api/hermes-channel/send
POST /api/hermes-channel/stream
POST /api/hermes-channel/persist-turn
```

The daemon routes Node UI chat to Hermes' OpenAI-compatible API server when
`dkg hermes setup` registers the default transport:

```text
http://127.0.0.1:8642/health
http://127.0.0.1:8642/v1/chat/completions
```

Enable the Hermes API server before starting the gateway:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

Use `--gateway-url <url>` when the Hermes API server is reachable somewhere
other than `http://127.0.0.1:8642`. Use `--bridge-url` only for a custom
same-host loopback bridge that implements `/health`, `/send`, and `/stream`.
Do not use a non-loopback `bridgeUrl`; remote targets should be registered as
gateways. If `--bridge-health-url` is supplied, it must belong to the same
configured bridge or gateway base so readiness checks cannot pass against one
endpoint while chat is routed to another.

Node UI chat is considered ready only when the bridge or gateway health route
responds successfully. When it is unavailable, Hermes may still be registered,
but the UI should show a degraded/offline bridge state.

## Auth And Security

- DKG daemon API calls use bearer auth from the node.
- The Python Hermes provider reads the DKG token from `$DKG_HOME/auth.token` or
  the setup-resolved DKG home in `$HERMES_HOME/dkg.json`, then `~/.dkg/auth.token`.
- Setup registration uses an explicit token environment variable when present,
  then falls back to `$DKG_HOME/auth.token` or `~/.dkg/auth.token`.
- Standalone loopback bridge calls use `x-dkg-bridge-token`. Non-loopback
  `bridgeUrl` values are ignored; use `gatewayUrl` for remote transports.
  Gateway targets do not receive that bridge token.
- Hermes `send` and `stream` require an enabled local-agent registration.
  `persist-turn` remains bearer-authenticated for provider persistence even
  when UI chat registration is unavailable.
- Adapter setup stores non-secret settings in `dkg.json`.
- Setup and reconnect install the bundled node skill to
  `$HERMES_HOME/skills/dkg-node/SKILL.md`; this should be the canonical Hermes
  profile copy, while `/.well-known/skill.md` remains the daemon-served HTTP
  version.
- Direct `dkg_publish` and `dkg_shared_memory_publish` are exposed by default
  so Hermes matches the node skill tool surface. Operators can hide them with
  `publish_tool: "disabled"` / `allow_direct_publish: false` in `dkg.json`, or
  `DKG_ALLOW_DIRECT_PUBLISH=false`.
- Context-graph admin mutation tools such as `dkg_context_graph_invite`,
  `dkg_participant_add`, `dkg_participant_remove`,
  `dkg_join_request_approve`, and `dkg_join_request_reject` are exposed by
  default. Operators can hide them with `allow_context_graph_admin_tools: false`
  in `dkg.json` or `DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS=false`.
- `dkg_assertion_import_file` requires a configured safe root through
  `DKG_HERMES_IMPORT_ROOTS`, `HERMES_DKG_IMPORT_ROOTS`, `DKG_IMPORT_ROOTS`, or
  adapter `import_roots`; imports outside those roots, symlink escapes, and
  obvious credential/wallet/DKG private-state paths are rejected.

## Troubleshooting

### Provider conflict

If setup reports an existing `memory.provider`, the target profile is already
using another memory backend. To switch it to DKG in this release, remove or
change that provider entry in the profile `config.yaml`, then rerun
`dkg hermes setup`. For a clean start, use a fresh Hermes profile.

### Hermes chat offline

If Node UI says Hermes is degraded or offline:

1. Confirm Hermes is running for the same profile.
2. Confirm `API_SERVER_ENABLED=true` is present in the active
   `$HERMES_HOME/.env`.
3. Confirm `http://127.0.0.1:8642/health` responds, or configure the DKG
   local-agent integration with the correct gateway URL.
4. Run:

```bash
dkg hermes doctor --profile research
```

5. Refresh the Hermes connected-agent panel in the Node UI.

### Windows and WSL2

Run Hermes inside WSL2. If the DKG daemon runs on Windows, do not rely on
`127.0.0.1` until you have verified reachability from WSL. Use an explicit
daemon URL:

```bash
dkg hermes setup --profile research --daemon-url http://<windows-host-ip>:9200
```

### Uninstall and reconnect

`disconnect` is reversible:

```bash
dkg hermes disconnect --profile research
dkg hermes reconnect --profile research
```

Use `uninstall` when you want to remove adapter-owned files:

```bash
dkg hermes uninstall --profile research
```

## Release Smoke Checklist

For release validation, record evidence for:

- DKG memory provider setup and verify
- duplicate setup idempotency
- provider conflict refusal
- Node UI connect, stream, refresh, and persisted history
- daemon restart recovery
- Hermes restart recovery
- disconnect, reconnect, and uninstall
- Windows/WSL2 reachability with an explicit daemon URL

Automated tests cover the TypeScript adapter, CLI option normalization, daemon
Hermes routes, duplicate persist behavior, local-agent readiness transitions,
and Node UI Hermes transport helpers.
