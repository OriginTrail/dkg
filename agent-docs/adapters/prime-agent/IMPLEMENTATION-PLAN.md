# Implementation plan — `packages/adapter-prime-agent`

Refs: `OriginTrail/dkg@843f5213`, `PrimeIntellect-ai/prime-agent@0e0d2339`.
Each stage is independently shippable and testable. **Stage 1 proves the
transport and nothing else.**

---

## Stage 0 — Resolve the two blocking unknowns (no PR)

Before any code, confirm at `path:line`:

1. **How an extension learns its active session id.** Needed for turn identity
   (DESIGN §Q6) and the discovery file (§Q7). Read `ExtensionContext`
   (`src/core/extensions/types.ts:291-320`) and the runtime that constructs it
   (`src/core/extensions/loader.ts:168-324`, `runner.ts`). If no field exists,
   pick the fallback (session-artifact path, or an extension-minted id) and
   record it in DESIGN's open-questions section.
2. **Whether a port can be bound at load time or only from `session_start`.**
   `refreshTools` is a documented no-op pre-bind (`loader.ts:136-137`), implying
   a two-phase lifecycle.

Exit: both answered in DESIGN.md with citations; no unverified API remains on
the Stage 1 path.

---

## Stage 1 — Prove the transport (single PR)

**Goal: a message typed in the Node UI reaches a *running* Prime Agent session
and streams back.** No memory, no tools, no skill package.

### New package (minimum viable file set)

| File | Role | Modeled on |
| --- | --- | --- |
| `packages/adapter-prime-agent/package.json` | `@origintrail-official/dkg-adapter-prime-agent`, `type: module`, `files: [dist, extension, dkg-skill, setup-entry.mjs, README.md, LICENSE]`, sole runtime dep `@origintrail-official/dkg-core` | `adapter-hermes/package.json:2-45` |
| `src/types.ts` | `PrimeAgentAdapterConfig`, `PrimeAgentSetupState`, `PrimeAgentSetupRequest/Result`, `PrimeAgentChannel*` — mirror the Hermes contract names | `adapter-hermes/src/types.ts` (408 lines) |
| `src/setup.ts` | Stage-1 subset: `resolvePrimeAgentProfile`, `planSetup`, `runPrimeAgentSetup`, `verify`, `disconnect`, `restore` | `adapter-hermes/src/setup.ts` exported surface only |
| `src/dkg-client.ts` | TS daemon client | `adapter-hermes/src/dkg-client.ts` (286) |
| `src/PrimeAgentAdapterPlugin.ts` | idempotent `register(api)`, `session_end` hook | `adapter-hermes/src/HermesAdapterPlugin.ts:34-48` |
| `src/prime-agent-routes.ts` | one route: `GET /api/prime-agent/status` | `adapter-hermes/src/hermes-routes.ts:6-16` |
| `src/index.ts` | barrel | `adapter-hermes/src/index.ts` |
| `setup-entry.mjs` | lazy re-exports + `registrationMode` gate + guarded runtime import | `adapter-hermes/setup-entry.mjs:1-50` |
| `extension/src/extension.ts` → `extension/dist/extension.js` | **the bridge**: `http.createServer` on `127.0.0.1:0`; `/health`, `/send`, `/stream`; token check; writes/removes the discovery file | `examples/extensions/file-trigger.ts` (pattern) |

### Existing files to change

| File | Edit |
| --- | --- |
| `packages/cli/src/daemon/local-agents.ts` | Add a `prime-agent` entry to `LOCAL_AGENT_INTEGRATION_DEFINITIONS` (`:93-131`): `transportKind: 'prime-agent-channel'`, capabilities `{localChat, connectFromUi, installNode, nodeServedSkill}` (attachments/memory arrive in later stages), `manifest {packageName, setupEntry: './setup-entry.mjs'}` |
| `packages/cli/src/daemon/local-agents.ts` | `connectLocalAgentIntegrationFromUi` currently hard-branches on `requested.id === 'hermes'` (`:503,514`) — add a `prime-agent` branch **or** generalize to a per-id handler map (preferred; note it in the PR) |
| `packages/cli/src/daemon/prime-agent.ts` **(new)** | Port `hermes.ts` target/health/header/stream helpers: `getPrimeAgentChannelTargets`, `probePrimeAgentChannelHealth`, `ensurePrimeAgentBridgeAvailable`, `buildPrimeAgentChannelHeaders`, `normalizePrimeAgentChatPayload`, `pipePrimeAgentStream` (delegate to `pipeOpenClawStream`), `transportPatchFromPrimeAgentTarget`. **Reuse OpenClaw types rather than forking them**, exactly as `hermes.ts:83-85,766-786` does. Add `readSessionDiscoveryDir()` — new, no Hermes analogue |
| `packages/cli/src/daemon/routes/prime-agent.ts` **(new)** | `POST /api/prime-agent-channel/{send,stream}`, `GET …/health`. Stage 1 omits `persist-turn` |
| `packages/cli/src/daemon/routes/index.ts` (or the dispatcher that calls `handleHermesRoutes`) | Register `handlePrimeAgentRoutes` |
| `packages/cli/src/cli.ts` | `registerPrimeAgentCommand` |
| `packages/cli/src/commands/prime-agent.ts` **(new)** | `setup/verify/status/doctor/disconnect/reconnect/uninstall`, mirroring `commands/hermes.ts` |
| `pnpm-workspace.yaml`, root `package.json`, `knip.json` | Register the new workspace package |
| **No change** to `packages/cli/src/config.ts` | `transport.kind` is an unconstrained `string` (`config.ts:388-393`) |

### Stage 1 tests

- `test/prime-agent-adapter.part-01.test.ts` — setup plan/state shape, first-wins snapshot, backup path naming.
- `test/bridge-contract.test.ts` — spin the extension's server standalone (no Prime Agent): assert `/health` returns `{ok:true}`, `/send` echoes `correlationId`, `/stream` emits `data: {...}\n\n` frames ending in `final`, and that a missing/incorrect `x-dkg-bridge-token` yields 401 and an absent expected token yields 503.
- Daemon-side unit tests for `getPrimeAgentChannelTargets` (loopback-only filtering) and `readSessionDiscoveryDir` (stale-pid pruning).

### Stage 1 exit criterion — "smallest thing that proves the transport works"

> With a Prime Agent session already running (started by the user, not by us),
> `curl -X POST http://127.0.0.1:9200/api/prime-agent-channel/send -d '{"text":"hi","correlationId":"c1"}'`
> returns the agent's reply, and the same call to `/stream` yields incremental
> `delta` frames followed by a `final` frame — **and `prime-agent list` shows the
> same session id it went to.**

That last clause is the real proof: it demonstrates *attach*, not *spawn*.

---

## Stage 2 — Turn persistence and identity

- Add `POST /api/prime-agent-channel/persist-turn` to `routes/prime-agent.ts`,
  reusing the dedupe machinery: in-flight map keyed `sessionId\nturnId`
  (`routes/hermes.ts:844-874`), state rank `stored > failed` (`:958-960`),
  `hasPersistedHermesTurn` semantics (`hermes.ts:681-686`).
- Extension emits a turn on `turn_end` (`types.ts:669`) carrying
  `{sessionId, correlationId, userMessage, assistantReply}`.
- Turn ids from `buildStableHermesTurnId` (`hermes.ts:654-674`) — **always pass a
  discriminator**, since the no-discriminator path is a random UUID (`:663`).
- Handle `session_start` with `reason: "fork" | "resume"` by **not** backfilling
  history (DESIGN §Q6).
- Tests: fork/clone produce disjoint turn ids; replayed sends are idempotent;
  worker-crash mid-turn persists nothing.

## Stage 3 — Tool surface

- Ship `dkg-skill/` (SKILL.md + pyproject.toml + `src/dkg/__init__.py` with a
  callable `run`), satisfying all four detection conditions
  (`src/core/skills.ts:202-254`).
- Register the 3 lifecycle tools via `pi.registerTool` (`types.ts:1081`).
- Setup installs the skill path into Prime Agent's skills resolution and
  verifies the kernel import (`ipython.ts:108-139` wraps a callable `run`).
- Tests: pytest suite mirroring `adapter-hermes/pytests/*` for the Python client;
  a TS test asserting the three tools register and appear in `getAllTools()`.

## Stage 4 — Memory election

- Hook set from DESIGN §Q2: `before_agent_start` recall injection,
  `turn_end` sync (already present from Stage 2), `session_shutdown` flush.
- Harness mirroring: read-only `loadHarnessState`/`mergeHarnessStates`
  (`refinement.ts:281,326`), publish `kind: "memory"` entries **tagged with
  scope**; never promote `local` to shared implicitly.
- `--memory-mode primary|tools-only` becomes meaningful.
- Tests: recall injection appears in `before_agent_start` output; local-scope
  entries are never published as shared; disconnect removes the hooks and
  restores `settings.json` surgically.

## Stage 5 — Node UI

- `ConnectedAgentsTab.tsx` gains a Prime Agent row + live-session count and
  selector; `hooks/useAgents.ts` and `ui/api.ts` extended.
- e2e `packages/node-ui/e2e/specs/prime-agent-connect.spec.ts`, mirroring
  `hermes-connect.spec.ts`, plus a case for "installed, no live session".

## Stage 6 (v2 candidates, each its own ADR)

- `session_before_compact` consolidation into Working Memory (DESIGN §Q8).
- `context` rewrite for pruning-with-provenance.
- HTTP MCP shim in front of `packages/mcp-dkg`, replacing the skill's transport
  (DESIGN §Q4) — needs its own auth/scoping design.
- Harness `skill` / `subagent` kinds in DKG.

---

## Test plan summary

| Layer | Mirrors | Adds |
| --- | --- | --- |
| TS unit | `adapter-hermes/test/*.part-NN.test.ts` (14 parts) | bridge-contract tests; discovery-dir tests |
| Python | `adapter-hermes/pytests/*` + `run-pytest.mjs` shim wired into `"test"` | kernel-skill import + guard tests |
| Node UI e2e | `hermes-connect.spec.ts` | no-live-session state |
| Manual | Hermes verification checklist (`adapter-hermes/README.md:114-124`) | "same session id" proof from Stage 1 |
