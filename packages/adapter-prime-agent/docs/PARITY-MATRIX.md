# Parity matrix — `adapter-hermes` → `adapter-prime-agent`

Every capability in `packages/adapter-hermes/README.md` as a row. No blanks:
each is **v1**, **v2**, or **dropped** with a reason.

Refs: `OriginTrail/dkg@843f5213`, `PrimeIntellect-ai/prime-agent@0e0d2339`.

## Setup flags

| Hermes behavior | Prime Agent equivalent | Mechanism | Scope | Risk |
| --- | --- | --- | --- | --- |
| `--profile <name>` | `--session <id>` (selects which live session's bridge to target) | Discovery dir `~/.prime/agent/.dkg-adapter-prime-agent/sessions/*.json` | **v1** | Med — semantics differ from Hermes profiles; a profile is durable, a session is not |
| `--daemon-url <url>` (default `http://127.0.0.1:9200`) | identical | Written to adapter `dkg.json` | **v1** | Low |
| `--gateway-url <url>` (default `:8642`) | **dropped** | Prime Agent has no OpenAI-compatible server (repo-wide search: only `node:net` sockets + OAuth loopback) | **dropped** | Low — nothing to point at |
| `--bridge-url <url>` (loopback only) | identical, but **derived** not user-set by default | Extension binds an ephemeral loopback port and publishes it | **v1** | Med — flag retained as an override for fixed-port deployments |
| `--bridge-health-url <url>` | identical | Same base + `/health` | **v1** | Low |
| `--port <port>` (9200) | identical | Daemon port | **v1** | Low |
| `--memory-mode primary\|tools-only` | identical vocabulary, different mechanism | `primary` installs the hook set (§Q2); `tools-only` installs the skill without recall/sync hooks | **v1** | Med — "primary" is weaker here: no provider slot means no exclusivity guarantee |
| `--network <name>` | identical | Node-side, unchanged | **v1** | Low |
| `--no-start` | identical | Adapter never starts Prime Agent; it cannot (no spawn path in the design) | **v1** | Low |
| `--fund` / `--no-fund` | identical | Node-side wallet funding, unchanged | **v1** | Low |
| `--preserve-provider` | `--preserve-settings` | Refuses to modify `settings.json.extensions` if a conflicting DKG entry exists | **v1** | Low |
| `--no-verify` | identical | Skips post-setup verify | **v1** | Low |
| `--dry-run` | identical | Plan-only; `HermesSetupPlan`-shaped action list | **v1** | Low |
| disconnect `--restore-provider` | `--restore-settings` | CLI opt-in; UI always restores (parity with `reverseHermesSetupForUi`) | **v1** | Low |

## Adapter config keys (`$HERMES_HOME/dkg.json` → `~/.prime/agent/.dkg-adapter-prime-agent/dkg.json`)

| Hermes key | Prime Agent | Mechanism | Scope | Risk |
| --- | --- | --- | --- | --- |
| `daemon_url` (env `DKG_DAEMON_URL`) | same | read by extension + kernel skill | **v1** | Low |
| `dkg_home` | same | token resolution root | **v1** | Low |
| daemon `auth.token` | `bridge_token` | setup copies the selected node token into private adapter `dkg.json` (mode `0600`) | **v1** | High |
| `bridge.gatewayUrl` | **dropped** | no gateway exists | **dropped** | Low |
| `bridge.url` / `bridge.healthUrl` | same, populated from the discovery file | | **v1** | Med (per-session) |
| `context_graph` (env `DKG_CONTEXT_GRAPH`) | same | | **v1** | Low |
| `memory_assertion` (env `DKG_MEMORY_ASSERTION`) | same | | **v1** | Low |
| `memory_mode` | same | `provider` renamed `hooks` internally; value kept for parity | **v1** | Low |
| `allow_direct_publish` (env `DKG_ALLOW_DIRECT_PUBLISH`, default false) | same, default false, **non-overridable from inside the agent** | kernel skill re-reads per call | **v1** | **High** — kernel runs model-authored Python as the user |
| `allow_context_graph_admin_tools` (default false) | same | | **v1** | High |
| `import_roots` (default `[]`) | same | | **v1** | High — kernel has filesystem access by construction |
| Token order `DKG_API_TOKEN` → `DKG_AUTH_TOKEN` → `dkg_home` → `DKG_HOME` → `~/.dkg`; never copied into agent config | **identical, verbatim** | | **v1** | Low |

## Routes

| Hermes route | Prime Agent | Mechanism | Scope | Risk |
| --- | --- | --- | --- | --- |
| `POST /api/hermes-channel/send` | `POST /api/prime-agent-channel/send` | new `routes/prime-agent.ts`, modeled on `routes/hermes.ts:191` | **v1** | Low |
| `POST /api/hermes-channel/stream` | `…/stream` | SSE passthrough via `pipeOpenClawStream` | **v1** | Low |
| `POST /api/hermes-channel/persist-turn` | `…/persist-turn` | reuse dedupe + state-rank logic (`routes/hermes.ts:844-874,958-960`) | **v1** | Med — turn identity differs (§Q6) |
| `GET /api/hermes-channel/health` | `…/health` | aggregates the discovery dir; reports per-session | **v1** | Med |
| `GET /api/hermes/status` (adapter-served) | `GET /api/prime-agent/status` | package-local, 18-line file | **v1** | Low |
| `/api/local-agent-integrations/*` | unchanged, plus a `prime-agent` branch | `local-agents.ts:503,514` and `routes/local-agents.ts:435-490` hard-branch per id | **v1** | Med — requires editing shared files |

## Config-file ownership

| Hermes file | Prime Agent file | Owner | Scope | Risk |
| --- | --- | --- | --- | --- |
| `~/.dkg/config.json` | same | DKG node | **v1** | Low |
| `$HERMES_HOME/config.yaml` (managed BEGIN/END block, `memory.provider`) | `~/.prime/agent/settings.json` (one entry appended to `extensions`) | **Prime Agent owns the file**; adapter owns one array entry | **v1** | **High** — JSON has no comment markers, so ownership lives in adapter state, not the file |
| `$HERMES_HOME/dkg.json` | `~/.prime/agent/.dkg-adapter-prime-agent/dkg.json` | adapter | **v1** | Low |
| `$HERMES_HOME/plugins/dkg/` (Python provider) | `…/dkg-skill/` installed editable into the kernel venv | adapter | **v1** | Med — `uv pip install --editable` (`bootstrap.ts:325-327`) |
| `$HERMES_HOME/skills/dkg-node/SKILL.md` | `dkg-skill/SKILL.md` (rewritten for the kernel convention) | adapter | **v1** | Med — drift vs `packages/cli/skills/dkg-node/SKILL.md` |
| `$HERMES_HOME/.dkg-adapter-hermes/` | `~/.prime/agent/.dkg-adapter-prime-agent/` | adapter | **v1** | Low |
| — | `…/.dkg-adapter-prime-agent/sessions/*.json` (new) | adapter | **v1** | Med — new concept, no Hermes analogue |

## Lifecycle verbs

| Hermes | Prime Agent | Scope | Risk |
| --- | --- | --- | --- |
| `setup` / `runHermesSetup` | same shape, same `HermesSetupResult`-style return | **v1** | Low |
| `verify` | same | **v1** | Low |
| `status` | same, plus live-session count | **v1** | Low |
| `doctor` | same, plus "extension installed but no live session" as a distinct diagnosis | **v1** | Med |
| `disconnect` / `reconnect` | same | **v1** | Low |
| `uninstall` (always restores, leaves `.bak.<ts>`) | same | **v1** | Low |
| first-wins `priorMemoryProvider` snapshot | first-wins `priorSettings` snapshot (array, not scalar) | **v1** | Med — restore is entry-removal, not wholesale replacement |
| `.bak.<unix-ts-ms>` sibling backup | identical | **v1** | Low |
| intent-before-destructive-write ordering | identical | **v1** | Low |
| surgical-then-rename restore + post-verify | identical, adapted to arrays | **v1** | Med |

## Memory election

| Hermes | Prime Agent | Mechanism | Scope | Risk |
| --- | --- | --- | --- | --- |
| `memory.provider: dkg` slot | **no slot exists** → hook set | `before_agent_start` / `turn_end` / `session_shutdown` | **v1** | **High** — invented mechanism, no host guarantee of exclusivity |
| `on_memory_write` mirror hook | mirror Harness `memory` entries (read-only) | `loadHarnessState` + `mergeHarnessStates` (`refinement.ts:281,326`) | **v1** | Med |
| — | Harness `skill` / `subagent` kinds | executable references; needs its own model | **v2** | Med |
| — | session-local harness scope (no Hermes analogue) | tag scope on publish; never promote local→shared implicitly | **v1** | **High** — privacy leak if mishandled |
| — | `context` rewrite for pruning-with-provenance | `ContextEvent` result replaces the array (`runner.ts:856-886`) | **v2** | High |
| — | `session_before_compact` consolidation | veto/replace `CompactionResult` (`types.ts:971`) | **v2** | High — on the agent's critical path |

## Tool surface

| Hermes | Prime Agent | Mechanism | Scope | Risk |
| --- | --- | --- | --- | --- |
| ~30 `dkg_*` model tools | Python `dkg` kernel skill (`import dkg; await dkg.query(...)`) | skill package contract (`skills.ts:202-254`) | **v1** | Med |
| — | 3 lifecycle tools (`dkg_status`, `dkg_connect_info`, `dkg_health`) | `pi.registerTool` (`types.ts:1081`) | **v1** | Low |
| Tool-count parity | **dropped** | Prime Agent ships exactly one built-in tool (`allToolNames = new Set(["ipython"])`, `src/core/tools/index.ts:46-47`); parity is meaningless | **dropped** | Low |
| MCP via `packages/mcp-dkg` | **dropped for v1** | dkg-mcp is stdio; Prime Agent drops non-HTTP (`mcp-manager.ts:73`) | **v2** | Med |

## Guards

| Hermes control | Prime Agent | Scope | Risk |
| --- | --- | --- | --- |
| `allow_direct_publish` default false | reproduced, hard default false | **v1** | High |
| `allow_context_graph_admin_tools` default false | reproduced | **v1** | High |
| `import_roots` operator-approved | reproduced | **v1** | High |
| loopback-only bridge URL validation | reproduced (setup throw + runtime drop + per-request re-check) | **v1** | Low |
| fail-closed send/stream when disabled (409 `INTEGRATION_DISABLED`) | reproduced; `persist-turn` stays ungated, as in Hermes | **v1** | Low |
| attachment provenance verification | reproduced by reusing `verifyHermesAttachmentRefsProvenance` | **v1** | Low |
| `x-dkg-bridge-token` check | reproduced **with a timing-safe comparison** (reference uses `!==`) | **v1** | Low |
| — | new: bridge binds `127.0.0.1` and rejects non-loopback Host | **v1** | Med |

## Node UI

| Hermes | Prime Agent | Scope | Risk |
| --- | --- | --- | --- |
| Connected Agents row, connect/refresh/disconnect | one installation-level row — **shipped** | **v1** | Low |
| — | live-session count — **shipped**; session **selector** deferred (needs a stable per-session label the descriptor does not carry) | v1 partial | Med — new UX, unreviewed |
| chat attachments (`capabilities.chatAttachments`) | **not** advertised: the daemon route omits the attachment-provenance pipeline, so the capability would promise more than the channel delivers | v2 | Low |
| e2e `hermes-connect.spec.ts` | `prime-agent-connect.spec.ts` — **shipped**, plus a zero-session case | **v1** | Low |

## Troubleshooting cases

| Hermes case | Prime Agent equivalent | Scope | Risk |
| --- | --- | --- | --- |
| Provider conflict with `--preserve-provider` | settings conflict with `--preserve-settings` | **v1** | Low |
| "Hermes chat offline" 5-step (API_SERVER_ENABLED, `:8642/health`, doctor, refresh) | rewritten: extension installed? live session? discovery file fresh? port bound? doctor; refresh | **v1** | Med |
| Windows/WSL2 → use `--daemon-url <windows-host-ip>:9200` | same guidance; bridge stays loopback-only inside the agent's host | **v1** | Med |
| uninstall/reconnect reversibility | identical | **v1** | Low |
| — | new: "extension installed but no session running" is a first-class, non-error state | **v1** | Med |
