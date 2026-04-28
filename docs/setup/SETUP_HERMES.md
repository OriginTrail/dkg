# Setting Up DKG V10 with Hermes Agent

This guide connects a Hermes profile to a local DKG V10 node. It reflects the
current PR behavior: profile-aware DKG setup helpers, DKG as an optional Hermes
memory provider, and Hermes-specific local-agent routes under
`/api/hermes-channel/*`.

## Prerequisites

- Node.js 22+ and pnpm for this DKG monorepo.
- A DKG node configured with `dkg init`.
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

## Provider Mode Setup

Use provider mode when DKG should be Hermes' active external memory provider.

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

The adapter refuses to overwrite an existing non-DKG memory provider. If the
profile already uses Honcho, Mem0, Supermemory, or another provider, choose
tools-only mode or switch providers explicitly.

## Tools-Only Setup

Use tools-only mode when Hermes should keep its current memory provider but
still have DKG profile state and local-agent registration metadata.

```bash
dkg hermes setup --profile research --memory-mode tools-only
```

Tools-only mode preserves `memory.provider` in `config.yaml`. It still writes
adapter state and installs the provider package files so `status`, `doctor`,
`disconnect`, `reconnect`, and `uninstall` can inspect and repair the
DKG/Hermes profile relationship. Model-injected DKG memory tools require
provider mode in this PR.

## CLI Helpers

```bash
dkg hermes setup --profile research --dry-run
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

## Local-Agent Chat

The DKG daemon exposes these Hermes-specific routes:

```text
GET  /api/hermes-channel/health
POST /api/hermes-channel/send
POST /api/hermes-channel/stream
POST /api/hermes-channel/persist-turn
```

The daemon defaults to a standalone Hermes bridge at:

```text
http://127.0.0.1:9202/{health,send,stream}
```

If the local-agent registry has a Hermes gateway URL, the daemon forwards to:

```text
<gateway-url>/api/hermes-channel/{health,send,stream}
```

Node UI chat is considered ready only when the bridge or gateway health route
responds successfully. When it is unavailable, Hermes may still be registered,
but the UI should show a degraded/offline bridge state.

## Auth And Security

- DKG daemon API calls use bearer auth from the node.
- The Python Hermes provider reads the DKG token from `$DKG_HOME/auth.token` or
  `~/.dkg/auth.token`.
- Standalone loopback bridge calls use `x-dkg-bridge-token`. Non-loopback
  `bridgeUrl` values are ignored; use `gatewayUrl` for remote transports.
  Gateway targets do not receive that bridge token.
- Adapter setup stores non-secret settings in `dkg.json`.
- Direct `dkg_publish` is guarded by default and should remain
  operator-reviewed unless explicitly enabled.

## Troubleshooting

### Provider conflict

If setup reports an existing `memory.provider`, either keep that provider with:

```bash
dkg hermes setup --profile research --memory-mode tools-only
```

or edit the Hermes profile config intentionally before rerunning provider mode.

### Bridge offline

If Node UI says Hermes is degraded or offline:

1. Confirm Hermes is running for the same profile.
2. Confirm the bridge is listening on `127.0.0.1:9202`, or configure the DKG
   local-agent integration with the correct gateway URL.
3. Run:

```bash
dkg hermes doctor --profile research
```

4. Refresh the Hermes connected-agent panel in the Node UI.

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

Before release, record evidence for:

- provider-mode setup and verify
- tools-only setup with an existing memory provider
- duplicate setup idempotency
- provider conflict refusal
- Node UI connect, stream, refresh, and persisted history
- daemon restart recovery
- Hermes restart recovery
- disconnect, reconnect, and uninstall
- Windows/WSL2 reachability with an explicit daemon URL

Automated tests cover the TypeScript adapter, CLI option normalization, daemon
Hermes routes, duplicate persist behavior, local-agent readiness transitions,
and Node UI Hermes transport helpers. Manual smoke evidence is still required
for release sign-off.
