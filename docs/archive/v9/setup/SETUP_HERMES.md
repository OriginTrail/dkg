# Setting Up DKG V10 with Hermes Agent

This guide connects a Hermes profile to a local DKG V10 node. It reflects the
current release behavior: profile-aware DKG setup helpers, DKG as Hermes'
default memory provider with a reversible replace-by-default switch, daemon
lifecycle parity with `dkg openclaw setup`, and DKG daemon-owned local-agent
routes under `/api/hermes-channel/*`.

## Prerequisites

- Node.js 22+ and npm for packaged installs, or pnpm for this DKG monorepo.
- Hermes Agent installed on Linux, macOS, WSL2, or Termux.

`dkg hermes setup` bootstraps the DKG node config when missing (no separate
`dkg init` is needed) and starts the daemon for you by default; pass
`--no-start` to keep an externally managed daemon, or `--preserve-provider` to
keep an existing non-DKG `memory.provider` instead of replacing it.

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

## Fresh User End-To-End Flow

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup
```

`dkg hermes setup` bootstraps `~/.dkg/config.json` when missing, starts the
DKG daemon (unless `--no-start` is passed), funds the node's generated admin and operational wallets
through the testnet faucet (unless `--no-fund` is passed), installs the DKG
Hermes plugin, elects DKG as the active `memory.provider` (replacing any
prior provider with a timestamped backup; `--preserve-provider` opts out),
and registers the Hermes integration with the daemon. After setup, enable
Hermes' API server and start the gateway:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

Existing-user equivalent: if a DKG daemon is already running, open the Node
UI at `http://127.0.0.1:9200/ui`, choose **Agents** in the right panel, and
click **Connect Hermes** — the daemon invokes the same setup the CLI does.

## DKG Memory Provider Setup

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

## CLI Helpers

```bash
dkg hermes setup --profile research --dry-run
dkg hermes setup --profile research --gateway-url https://hermes.example.com
dkg hermes status --profile research
dkg hermes verify --profile research
dkg hermes doctor --profile research
dkg hermes disconnect --profile research
dkg hermes disconnect --profile research --restore-provider
dkg hermes reconnect --profile research
dkg hermes uninstall --profile research
```

`status`, `verify`, and `doctor` inspect the profile path and setup-state
metadata. `disconnect` removes the managed provider election block and marks
the DKG adapter disconnected; pass `--restore-provider` to also restore the
prior `memory.provider` captured at first setup. `uninstall` always restores
the prior provider before removing ownership-marked DKG adapter artifacts and
preserves user-owned Hermes data.

Lifecycle commands reuse persisted daemon and bridge settings from
`setup-state.json` when flags are omitted, so a profile configured with a
custom daemon URL or gateway does not fall back to localhost during
`disconnect`, `reconnect`, or `uninstall`.

### `dkg hermes setup` Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--profile <name>` | default profile | Target `~/.hermes/profiles/<name>` instead of `~/.hermes`. |
| `--daemon-url <url>` | `http://127.0.0.1:9200` | DKG daemon URL. First-wins over `--port` when both are set. |
| `--bridge-url <url>` | unset | Custom same-host Hermes bridge URL. Loopback only; use `--gateway-url` for WSL2 or remote transports. |
| `--gateway-url <url>` | `http://127.0.0.1:8642` | Hermes OpenAI-compatible API server URL for Node UI chat. |
| `--bridge-health-url <url>` | derived from transport | Optional health URL override. Must belong to the configured bridge or gateway base. |
| `--port <port>` | `9200` | Shortcut for `--daemon-url http://127.0.0.1:<port>`. |
| `--memory-mode <mode>` | `primary` | `primary` elects DKG as the Hermes memory provider; `tools-only` skips provider election and exposes DKG tools only. |
| `--dry-run` | off | Preview planned file changes, daemon start, and faucet calls without writing or invoking anything. No backup file is written. |
| `--no-verify` | off | Skip the post-setup verification pass. |
| `--no-start` | off (daemon starts) | Skip starting the DKG daemon. Best-effort daemon registration still fires against an already-running daemon. |
| `--no-fund` / `--fund` | `--fund` | Fund the node's generated admin and operational wallets through the testnet faucet. `--no-fund` skips the faucet call. Faucet failures are non-fatal; a manual `curl` block is logged. |
| `--preserve-provider` | off (replace) | Refuse to replace an existing non-DKG `memory.provider`. Restores the pre-#386 throw-on-conflict behavior for advanced users. |
| `--no-replace-provider` | off (replace) | Alias for `--preserve-provider`. |

### `dkg hermes disconnect` Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--profile <name>` | default profile | Target the named profile's Hermes home. |
| `--dry-run` | off | Preview planned changes without writing. |
| `--restore-provider` | off (disconnect-only) | After removing the managed DKG block, restore the prior `memory.provider` captured at first setup. UI Disconnect always restores; the CLI requires this opt-in. |

## Provider-Replacement Behavior

`dkg hermes setup` elects DKG as the active Hermes `memory.provider` by
default, even when the target profile already has another provider configured.
The replacement is reversible: setup snapshots the prior provider before it
rewrites `config.yaml` so disconnect or uninstall can put it back.

### What setup writes before replacing

When replacing a non-DKG `memory.provider`, setup performs these writes in
order:

1. `<hermesHome>/.dkg-adapter-hermes/setup-state.json` is written with
   `priorMemoryProvider = { provider, configBackupPath, capturedAt }` recording
   the intent to swap. This write happens **before** any destructive change.
2. `<hermesHome>/config.yaml.bak.<unix-ts-ms>` is written as a sibling of
   `config.yaml`, holding the pre-replacement bytes verbatim.
3. `<hermesHome>/config.yaml` is rewritten with the managed
   `# BEGIN/END DKG ADAPTER HERMES MANAGED` block selecting `memory.provider:
   dkg`.

The intent-first write order is deliberate: a `Ctrl-C` between steps 1 and 2,
or between steps 2 and 3, leaves a recoverable state on disk. A re-run sees
the persisted `priorMemoryProvider` and routes restore to the captured backup
path even if the rewrite itself never completed.

`priorMemoryProvider` is **first-wins**. Re-running setup against an
already-DKG-elected profile (or after a previous replacement) does not
overwrite the captured snapshot, does not write a new backup, and does not
touch the managed block — `config.yaml` is byte-identical across re-runs.

### Restore semantics

`restoreHermesProfile` (invoked by `dkg hermes disconnect --restore-provider`,
`dkg hermes uninstall`, and Node UI Disconnect) reads
`state.priorMemoryProvider` and tries the following paths in order:

1. **Surgical line-rewrite.** Rewrites the active `memory.provider` line back
   to the captured provider name. Preferred because it preserves any unrelated
   edits made to `config.yaml` since setup landed.
2. **Backup-file fallback.** If the surgical rewrite fails (parse error,
   missing top-level `memory:` block, drifted indentation), atomically renames
   the captured `configBackupPath` over `config.yaml`. Safer for badly
   drifted configs but loses any post-setup edits.
3. **Noop / failed.** Returns `path: 'noop'` when no `priorMemoryProvider` was
   ever captured (fresh install of DKG, or a re-run that never replaced).
   Returns `path: 'failed'` when both restore paths fail (e.g., backup file
   deleted by the operator); restore failure does **not** roll back the
   disconnect — the integration stays disconnected and the restore error
   surfaces as a warning.

### Opting out

Pass `--preserve-provider` (or its alias `--no-replace-provider`) to keep the
pre-#386 behavior: setup refuses to replace an existing non-DKG provider and
exits with `Refusing to replace existing Hermes memory.provider: <name>`. To
switch that profile to DKG manually, remove or change the existing
`memory.provider` entry in `config.yaml`, then rerun `dkg hermes setup`.

### Restoring on disconnect

```bash
dkg hermes disconnect --profile research --restore-provider
```

Removes the managed DKG block and restores the prior provider in one call.
Without `--restore-provider`, disconnect removes only the managed block and
leaves the active provider in its post-setup (DKG) state for re-attach.

`dkg hermes uninstall` always restores the prior provider before removing
adapter-owned files; the captured backup file is left in place for operator
rollback.

## Local-Agent Chat (Node UI)

The DKG daemon exposes these Hermes-specific routes. They are supported daemon
routes, not standalone HTTP handlers exported by `packages/adapter-hermes`:

```text
GET  /api/hermes-channel/health
POST /api/hermes-channel/send
POST /api/hermes-channel/stream
POST /api/hermes-channel/persist-turn
```

The daemon routes Node UI chat to Hermes' OpenAI-compatible API server when
Hermes setup has registered the default transport:

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

### Connect, Refresh, and Disconnect

- **Connect Hermes** runs the same setup the CLI does. No separate
  `dkg hermes setup` invocation is required for the Connect-button flow; the
  daemon invokes `runHermesSetup` against the resolved profile, transitions
  the integration to `ready` once the post-setup verify passes, and to
  `degraded` or `error` otherwise.
- **Refresh** re-probes Hermes bridge/gateway health only. It does not
  re-run setup, does not mutate `config.yaml`, and does not retake the
  provider backup.
- **Disconnect** removes the managed DKG provider block via
  `disconnectHermesProfile` and then restores the prior `memory.provider`
  via `restoreHermesProfile`. The UI always restores (the CLI requires
  `--restore-provider`). Chat and memory history are preserved across
  Disconnect — the `urn:dkg:chat:session:hermes:dkg-ui:*` slot and the
  `memory` assertion in `agent-context` are untouched.

If restore fails after disconnect, the integration stays in the
`disconnected` state and the restore error surfaces as a warning chip on the
disconnected row in the Node UI. Reconnect is available without manual
intervention.

Node UI chat is considered ready only when the bridge or gateway health route
responds successfully. When it is unavailable, Hermes may still be registered,
but the UI shows a degraded/offline bridge state.

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

### Provider conflict (with `--preserve-provider`)

If setup is invoked with `--preserve-provider` against a profile that already
has another `memory.provider` configured, setup exits with
`Refusing to replace existing Hermes memory.provider: <name>`. To switch that
profile to DKG, drop the flag and rerun `dkg hermes setup`. The prior
provider is captured into `setup-state.json` and a `config.yaml.bak.<ts>`
backup is written before the replacement, so the change is reversible via
`dkg hermes disconnect --restore-provider` or `dkg hermes uninstall`.

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

To also restore the prior `memory.provider` on disconnect, pass
`--restore-provider`:

```bash
dkg hermes disconnect --profile research --restore-provider
```

Use `uninstall` when you want to remove adapter-owned files (the prior
provider is restored automatically before removal):

```bash
dkg hermes uninstall --profile research
```

## Release Smoke Checklist

For release validation, record evidence for:

- DKG memory provider setup and verify (fresh + replace-by-default)
- duplicate setup idempotency (byte-equal `config.yaml`, no second backup)
- `--preserve-provider` opt-out path (throw-on-conflict preserved)
- `--no-start` and `--no-fund` parity
- Node UI connect, stream, refresh, and persisted history
- Disconnect with provider restore (UI always; CLI `--restore-provider`)
- daemon restart recovery
- Hermes restart recovery
- disconnect, reconnect, and uninstall
- Windows/WSL2 reachability with an explicit daemon URL

Automated tests cover the TypeScript adapter, CLI option normalization, daemon
Hermes routes, duplicate persist behavior, local-agent readiness transitions,
provider-swap capture and restore, SIGINT-safe partial-state recovery, and
Node UI Hermes transport helpers.
