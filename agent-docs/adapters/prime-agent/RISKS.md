# Risks — `adapter-prime-agent`

Refs: `OriginTrail/dkg@843f5213`, `PrimeIntellect-ai/prime-agent@0e0d2339` (v0.7.0, MIT).

## R1 — Upstream API churn (`pi-coding-agent` lineage)

Prime Agent descends from `pi` / pi-mono (`@earendil-works/pi-coding-agent`), so
the extension API's stability is partly governed by a third-party project. The
design deliberately depends on a **small** slice: `pi.on`, `pi.sendUserMessage`,
`pi.registerTool`, and the lifecycle events `session_start`, `session_shutdown`,
`turn_end`, `before_agent_start`, `message_update`.

- **Breaks loudly:** a renamed/removed method — the extension throws at load and
  the discovery file is never written, so the daemon reports `BRIDGE_OFFLINE`.
- **Breaks silently:** an event that stops firing (e.g. `message_update` payload
  loses `assistantMessageEvent`). Streaming would degrade to nothing while
  `/health` still returns `ok: true`.
- **Detection:** the bridge must assert its own liveness — if a `/send` produced
  no `message_update` within N seconds but the turn completed, report degraded.
  Pin the tested Prime Agent version in adapter docs and re-run the
  bridge-contract test against each new release.

## R2 — Daemon protocol is explicitly not a stable public schema (avoided, not eliminated)

The socket protocol disclaims itself — *"not the final remote gateway
protocol"* (`src/modes/daemon/daemon-protocol.ts:42-49`), *"not promises of a
stable public network schema"* (`docs/agent-connection.md:85`) — and moved 4→7
with 13 schema revisions while the docs still say v4 (`docs/daemon.md:76`).
ADR 0007 avoids it entirely. Residual exposure: we still rely on the *daemon's
process model* (one resident worker per root session tree, extensions loaded in
the worker, `docs/daemon.md:23-27`). If that model changes — e.g. extensions
move to a separate host process — the in-process `pi.sendUserMessage` path
changes shape.

- **Breaks loudly:** extension fails to load or `sendUserMessage` throws.
- **Detection:** version-pinned smoke test per release.

## R3 — Per-session ports and extension lifetime (the design's own new surface)

Extensions load per session, so each live session binds its own listener. The
discovery directory is our invention, not a host feature.

- **Breaks silently:** a crashed worker leaves a stale
  `sessions/<id>.json`; the daemon dials a dead port and reports a confusing
  error, or worse, a *recycled* port belonging to something else.
- **Mitigation:** record `pid` and `startedAt`; prune entries whose pid is gone
  before use; require `/health` to echo the `sessionId` so a wrong-process
  answer is detectable.
- **Detection:** health probe compares echoed `sessionId` with the file.

## R4 — No memory-provider slot means no exclusivity guarantee

Hermes' `memory.provider: dkg` is an assertion the host honours. Our hook set is
not: another extension can register the same events, and the Continual Harness
keeps operating regardless (host `/refine` at `agent-session.ts:7571`, plus the
kernel-side Python store).

- **Breaks silently:** a second extension also injects recall, or `/refine`
  writes memory the adapter never mirrors — the user believes DKG is the memory
  of record when it is one of several.
- **Mitigation:** `verify` enumerates other extensions in `settings.json` and
  warns on any that register the same hooks; `status` states plainly that
  election is advisory.
- **Detection:** setup-time and `doctor`-time enumeration.

## R5 — Harness scope leakage (privacy)

Harness entries default to **session-local** scope
(`refinement.ts:768`, `:1015`), stored under
`session-artifacts/<sessionId>/harness/`. DKG Context Graphs are shared by
construction, and — per the merged integration entry — *every member of a bound
channel is effectively a reader of that graph*.

- **Breaks silently and irreversibly:** publishing local-scope entries to a
  shared graph exposes per-session scratch state; on-chain publication makes it
  permanent.
- **Mitigation:** never publish `scope: "local"` entries without an explicit
  operator opt-in; tag scope on every published assertion; default
  `allow_direct_publish: false` (see R7).
- **Detection:** a test asserting local-scope entries are filtered, plus a
  publish-time guard.

## R6 — Docs/source drift in prime-agent (found, not hypothetical)

Confirmed divergences at this SHA:

| Doc claim | Source reality |
| --- | --- |
| daemon protocol "v4" (`docs/daemon.md:76`, `docs/agent-connection.md:105`) | `DAEMON_PROTOCOL_VERSION = 7`, schema rev 13 (`daemon-protocol.ts:52,59`) |
| `"packages": ["pi-skills", "@org/my-extension"]` are npm packages (`docs/settings.md:239-244`) | `parseSource` classifies anything without an `npm:`/`git:`/`github:`/`http(s):`/`ssh:` prefix as a **local path** (`package-manager.ts:1385-1408`; test `test/package-manager.test.ts:857-861`) |
| `mcp_base.py:125` "unless a subclass overrides `_open_streams`" | the actual method is `_open_session` (`mcp_base.py:206`) |

**Consequence for us:** the design uses `settings.json.extensions` (unambiguous)
rather than `packages`, and never trusts a doc statement that source contradicts.
**Detection:** re-verify every cited `path:line` at each version bump.

## R7 — Prime Agent is not a sandbox

The kernel executes model-generated Python and extensions run with *"your full
system permissions"* (`docs/extensions.md:110`); the daemon docs state it is
*"not a sandbox boundary: all processes still run as the same OS user"*
(`docs/daemon.md:120`).

- **Breaks catastrophically and silently:** a model-authored script calls the
  DKG skill with `allow_direct_publish` enabled and publishes to mainnet.
- **Mitigation:** `allow_direct_publish` and
  `allow_context_graph_admin_tools` hard-default `false`; the skill re-reads
  config per call rather than caching; `import_roots` enforced; publication
  remains a node-side decision.
- **Detection:** guard tests that assert a publish attempt is refused with the
  default config.

## R8 — Shared-file edits in `packages/cli`

`connectLocalAgentIntegrationFromUi` hard-branches on `id === 'hermes'`
(`local-agents.ts:503,514`) and the disconnect handler branches per id
(`routes/local-agents.ts:435-490`). Adding a third agent means touching files
Hermes and OpenClaw both depend on.

- **Breaks loudly:** a bad branch breaks Hermes connect in CI.
- **Mitigation:** generalize to a handler map in the same PR, with the existing
  Hermes/OpenClaw tests as the regression net.

## R9 — Kernel-venv install fragility

Skills install editable via `uv pip install --editable`
(`bootstrap.ts:325-327,803-811`); reinstall is keyed on a `pyproject.toml` hash
(`:778-782`); a failing install is downgraded to a **warning**, not an error
(`:816-821`); and `PRIME_AGENT_KERNEL_PYTHON` disables installation entirely
(`:859`, `:880`).

- **Breaks silently:** the DKG skill is absent, imports raise
  `_PrimeAgentUnavailableSkill` (`ipython.ts:89-106`), and the user sees a
  runtime error only when the model calls it.
- **Detection:** `verify` executes a kernel import probe and fails loudly if the
  skill is not importable; `doctor` reports `PRIME_AGENT_KERNEL_PYTHON` if set.

## R10 — Turn-identity divergence

`buildStableHermesTurnId` falls back to a random UUID when no discriminator is
supplied (`hermes.ts:663`), which silently disables idempotency.

- **Breaks silently:** duplicate turns after a retry.
- **Mitigation:** the bridge always echoes `correlationId`; a unit test asserts
  a missing discriminator is treated as a programming error, not a fallback.

## Version pinning strategy

1. **Record both SHAs** in every design and ADR document (done).
2. **Pin a tested Prime Agent version range** in the adapter README; treat a
   minor bump as requiring the bridge-contract test to be re-run.
3. **No runtime dependency** on `@earendil-works/pi-coding-agent`; types-only if
   at all (DESIGN §Q10), so upstream packaging changes cannot break our install.
4. **Re-verify citations** at each bump — the doc/source drift in R6 shows the
   docs are not a safe substitute.

## Silent-vs-loud summary

| Failure | Mode | Detection |
| --- | --- | --- |
| Extension API renamed | **Loud** | load error → no discovery file → `BRIDGE_OFFLINE` |
| `message_update` payload changes | **Silent** | no-stream-but-turn-completed assertion |
| Stale discovery file / recycled port | **Silent** | pid prune + `sessionId` echo in `/health` |
| Competing memory extension | **Silent** | `verify`/`doctor` enumeration |
| Local-scope harness leak | **Silent, irreversible** | scope filter + publish guard test |
| Kernel skill not installed | **Silent until called** | `verify` import probe |
| Direct publish with default config | **Silent, costly** | guard test |
| Turn-id fallback to UUID | **Silent** | discriminator-required unit test |
