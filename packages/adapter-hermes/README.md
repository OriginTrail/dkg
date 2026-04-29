# DKG Adapter for Hermes Agent

`@origintrail-official/dkg-adapter-hermes` connects a local
[Hermes Agent](https://github.com/nousresearch/hermes-agent) profile to a DKG
V10 node. The DKG daemon stays the owner of graph state, auth, wallets,
context graphs, local-agent registry state, and Node UI chat persistence.
Hermes stays the owner of its profile directory, `config.yaml`, `.env`,
session state, plugins, tools, and runtime logs.

This package contains:

- `src/` - TypeScript setup helpers, daemon client helpers, and Hermes channel
  payload/client contracts.
- `hermes-plugin/` - Python Hermes memory provider plugin and DKG daemon
  client.

## Current Status

The adapter now provides the DKG-side setup and local-agent contracts for
Hermes. It includes profile-aware setup helpers, guarded publish behavior,
provider conflict handling, and client contracts for the daemon-owned
`/api/hermes-channel/*` routes.

Supported Hermes channel routes are registered by the DKG CLI daemon, not by
this adapter package as standalone HTTP stubs.

The Hermes local bridge process that answers chat requests must expose
`/health`, `/send`, and `/stream` on its configured bridge URL, or equivalent
gateway routes under `/api/hermes-channel/*`. Until that bridge is running,
the node can register Hermes but chat stays degraded/offline.

## Architecture

```text
Hermes profile                         DKG daemon
-------------------------------        ---------------------------------
$HERMES_HOME/config.yaml               ~/.dkg/config.json
$HERMES_HOME/dkg.json                  localAgentIntegrations.hermes
$HERMES_HOME/.dkg-adapter-hermes/      /api/hermes-channel/*
$HERMES_HOME/plugins/dkg/             ChatMemoryManager persistence

DKGMemoryProvider  -> bearer HTTP ->   DKG V10 routes and graph storage
Node UI chat       -> daemon route ->  Hermes bridge/gateway -> Hermes
```

The default profile home is `~/.hermes`. A named profile resolves to
`~/.hermes/profiles/<profile>`. If `HERMES_HOME` is set, the setup helpers use
that path directly. This matches Hermes' own `get_hermes_home()` behavior.

## CLI Helpers

The DKG CLI exposes:

```bash
dkg hermes setup
dkg hermes status
dkg hermes verify
dkg hermes doctor
dkg hermes disconnect
dkg hermes reconnect
dkg hermes uninstall
```

Common setup flags:

| Flag | Purpose |
| --- | --- |
| `--profile <name>` | Target `~/.hermes/profiles/<name>` instead of the default profile. |
| `--daemon-url <url>` | DKG daemon URL. Defaults to `http://127.0.0.1:9200`. |
| `--bridge-url <url>` | Same-host Hermes bridge URL for local chat. Use loopback addresses only. |
| `--gateway-url <url>` | Gateway URL for WSL2 or remote Hermes chat. |
| `--bridge-health-url <url>` | Optional health URL override for the configured bridge/gateway. |
| `--port <port>` | Shortcut for `http://127.0.0.1:<port>`. |
| `--memory-mode <mode>` | `primary` maps to provider-election mode and is the default path; use `tools-only` to preserve an existing Hermes memory provider. |
| `--dry-run` | Print planned file changes without writing them. |
| `--no-verify` | Skip the post-setup verification pass. |
| `--no-start` | Configure files without best-effort daemon registration. |

`setup` is non-interactive and idempotent. It writes ownership-marked adapter
state only under the resolved Hermes profile:

- `$HERMES_HOME/dkg.json`
- `$HERMES_HOME/plugins/dkg`
- `$HERMES_HOME/.dkg-adapter-hermes/setup-state.json`
- a managed `memory.provider: dkg` block in `$HERMES_HOME/config.yaml` when
  provider mode is selected

`disconnect` removes only the managed provider election block and marks the
adapter disconnected. `uninstall` removes ownership-marked adapter artifacts.
It does not delete Hermes sessions, logs, `.env`, non-DKG skills, or unrelated
profile data.

## Provider Mode vs Tools-Only Mode

Hermes allows one external memory provider at a time. In provider mode, setup
elects DKG as the active Hermes memory provider by writing a managed
`memory.provider: dkg` block. If `config.yaml` already names another provider,
for example Honcho, Mem0, or Supermemory, setup refuses to replace it.

Use tools-only mode when you want local-agent registration and DKG profile
state without changing Hermes' active memory provider:

```bash
dkg hermes setup --profile research --memory-mode tools-only
```

Tools-only mode preserves the existing provider and still writes DKG adapter
state (`dkg.json`, the provider plugin files, and setup-state metadata) so
status, doctor, reconnect, and uninstall can reason about the profile. In this
release, model-injected DKG memory tools are available when Hermes activates the DKG
memory provider; a separate general Hermes tool plugin for tools-only mode is
future work.

## Hermes Memory Provider

When active as `memory.provider: dkg`, the Python provider:

- loads DKG settings from `$HERMES_HOME/dkg.json`, with environment overrides
  such as `DKG_DAEMON_URL`, `DKG_CONTEXT_GRAPH`, and `DKG_AGENT_NAME`
- reads the DKG bearer token from `$DKG_HOME/auth.token` or `~/.dkg/auth.token`
- redacts bearer tokens from client errors
- stores persistent facts in a DKG assertion for the configured context graph
- syncs completed turns in a background thread with stable turn IDs and
  idempotency keys
- queues local writes in `$HERMES_HOME/dkg_cache*.json` when the daemon is
  unavailable

Direct Verified Memory publishing is guarded by default. The `dkg_publish`
tool is not exposed unless direct publish is explicitly enabled through the
adapter publish guard or `DKG_ALLOW_DIRECT_PUBLISH=true`. By default, publish
flows should remain operator-reviewed.

## Local-Agent Routes

Hermes uses Hermes-specific daemon routes for this release. These routes are
supported by the DKG CLI daemon; this adapter package provides the setup,
client, and payload contracts that call into them.

| Route | Purpose |
| --- | --- |
| `GET /api/hermes-channel/health` | Probe configured Hermes bridge/gateway health and update local-agent readiness. |
| `POST /api/hermes-channel/send` | Forward a non-streaming Node UI message to the Hermes bridge. |
| `POST /api/hermes-channel/stream` | Forward a streaming Node UI message and proxy SSE frames back to the UI. |
| `POST /api/hermes-channel/persist-turn` | Persist a completed Hermes turn through DKG chat memory with duplicate-turn protection. |

The daemon forwards Node UI chat to a standalone bridge at
`http://127.0.0.1:9202` by default. Setup does not persist that fallback as an
explicit transport. Use `dkg hermes setup --gateway-url <url>` when Hermes is
reachable through a WSL2 or remote gateway; the daemon then uses
`<gateway>/api/hermes-channel/{health,send,stream}` instead.

Attachment references are node-owned assertion refs. The daemon verifies their
provenance before forwarding them to Hermes.

## Auth And Security

- Non-public DKG daemon routes use the existing bearer token auth.
- The Python client reads the DKG token from `DKG_HOME`/`~/.dkg`; it does not
  require copying the token into Hermes config.
- Setup registration uses the same bearer source: explicit token environment
  variables first, then `$DKG_HOME/auth.token` or `~/.dkg/auth.token`.
- Standalone loopback Hermes bridge calls use a route-scoped
  `x-dkg-bridge-token` header. Non-loopback `bridgeUrl` values are ignored;
  use `gatewayUrl` for remote transports. Gateway targets do not receive that
  bridge token.
- Hermes `send` and `stream` routes fail closed when the Hermes integration is
  not enabled in the DKG local-agent registry. `persist-turn` remains
  daemon-authenticated so the active Hermes provider can persist completed
  turns even when UI chat registration is unavailable.
- The default bridge host is loopback. Treat non-loopback gateway URLs as an
  explicit trust decision and require normal network hardening.
- Verified Memory publishing is permanent and may cost TRAC; direct publish is
  disabled by default.

## Verification Status

Automated coverage in this branch includes:

```bash
pnpm --filter @origintrail-official/dkg-adapter-hermes run build
pnpm --filter @origintrail-official/dkg-adapter-hermes test
pnpm --filter @origintrail-official/dkg exec vitest run test/daemon-hermes.test.ts test/hermes-setup-cli-args.test.ts
pnpm --filter @origintrail-official/dkg-node-ui exec vitest run test/openclaw-bridge.test.ts test/ui-api-stream.test.ts
pnpm build:runtime
```

Manual smoke still needs to be recorded before release readiness:

1. Start a DKG daemon.
2. Run `dkg hermes setup --profile dkg-smoke --dry-run`.
3. Run `dkg hermes setup --profile dkg-smoke`.
4. Run `dkg hermes verify --profile dkg-smoke`.
5. Start Hermes with that profile.
6. Connect Hermes from the DKG Node UI.
7. Verify streamed chat, persisted history, refresh/degraded recovery, and
   disconnect/reconnect/uninstall behavior.
8. Repeat the path where Hermes runs in WSL2 and the DKG daemon runs on
   Windows, using an explicit daemon URL reachable from WSL.

## Development

```bash
pnpm --filter @origintrail-official/dkg-adapter-hermes run build
pnpm --filter @origintrail-official/dkg-adapter-hermes test
python -m py_compile packages/adapter-hermes/hermes-plugin/__init__.py packages/adapter-hermes/hermes-plugin/client.py
```

## More Setup Detail

See [Hermes setup](../../docs/setup/SETUP_HERMES.md).

## License

Apache-2.0
