# Design — `packages/adapter-prime-agent`

Collocating a Prime Intellect **Prime Agent** with a DKG V10 node, the way
`packages/adapter-hermes` collocates a Hermes agent.

| Repo | Ref this document was written against |
| --- | --- |
| `OriginTrail/dkg` | `843f5213d172096500a176eeda56e7e3ec0233c3` (`upstream/main`, 2026-08-04, release/10.0.12-bump) |
| `PrimeIntellect-ai/prime-agent` | `0e0d23391bcd879f1aea70dbda4d07dda7970b34` (2026-08-06, `v0.7.0`) |

Status: **design only**. No adapter code has been written.

---

## Recommendation in one paragraph

Ship the adapter as a **Prime Agent extension that hosts a loopback HTTP bridge**
implementing the `/health`, `/send`, `/stream` contract the DKG daemon already
speaks, plus a **Python-backed `dkg` kernel skill** for the model-facing tool
surface, plus a thin TypeScript setup package that mirrors the `adapter-hermes`
lifecycle verbs. The extension is the load-bearing choice: extensions are
`jiti`-imported *into the process that owns the running session*
(`packages/coding-agent/src/core/extensions/loader.ts:331-351`), so the bridge is
genuinely inside an already-resident session — real collocation, not a spawned
second agent — and it depends only on the documented extension API rather than
Prime Agent's daemon wire protocol, which its own header calls *"not the final
remote gateway protocol"* (`src/modes/daemon/daemon-protocol.ts:42-49`). Memory
election has no provider slot to swap, so it is re-derived as a **hook set**
(`before_agent_start` recall injection, `turn_end` sync, `session_shutdown`
flush) writing through to the **Continual Harness**, with the Hermes ownership
contract (first-wins prior-state snapshot → timestamped backup → managed region)
re-implemented against `settings.json`. The one genuinely new problem Hermes
never had is **N concurrent resident sessions, each loading its own extension
instance and therefore its own bridge port**; §Q7 defines a discovery file to
solve it.

---

## Corrections to the brief

Recorded before anything is built on them.

| Brief said | Source says |
| --- | --- |
| Deliverables go in `agent-docs/` and `agent-docs/adr/` | Neither path exists upstream. The ADR convention is `.ai/adr/NNNN-kebab-title.md` (0002–0006, kafka-plugin series) plus `docs/adr/0001-*`. Next free number is **0007**. The ADR for Q1 is written there; the other four documents are placed under `agent-docs/adapters/prime-agent/` as instructed, creating the directory. |
| Prime Agent daemon "protocol v4" | Code is **protocol 7, schema revision 13** — `DAEMON_PROTOCOL_VERSION = 7` (`daemon-protocol.ts:52`), `DAEMON_SCHEMA_REVISION = 13` (`:59`), `DAEMON_SCHEMA_ID = "protocol-7-schema-13-816309b1cd50"` (`:60`). The docs still say v4 (`docs/daemon.md:76`, `docs/agent-connection.md:105`). The wire moved 4→7 while the prose did not — a stability signal in itself. |
| `~30 dkg_*` tools is the parity target | Prime Agent ships **exactly one** built-in tool: `allToolNames = new Set(["ipython"])` (`src/core/tools/index.ts:46-47`); `read/write/grep/find/ls` were removed and are explicitly rejected (`src/cli/args.ts:63,161-167`). Tool-count parity is not a meaningful goal here. |
| Adapters upstream include `adapter-neo4j` | Upstream has `adapter-hermes`, `adapter-openclaw`, `adapter-elizaos`. `adapter-neo4j` exists only in the local fork. |
| MCP "auth is OAuth 2.1 with DCR, or `bearerTokenEnvVar`" | Both true, and `bearerTokenEnvVar` alone is sufficient for enablement (`src/core/mcp/mcp-manager.ts:129-131`). OAuth additionally requires RFC 7591 dynamic client registration; pre-registered client ids are unsupported (`docs/mcp-integrations.md:170-174`). |

---

## Parity model, filled in

| Layer | Hermes mechanism | Prime Agent mechanism (this design) | Status |
| --- | --- | --- | --- |
| **1. Memory election** | `memory.provider: dkg` inside a managed BEGIN/END block in `config.yaml`; first-wins `priorMemoryProvider` snapshot; `.bak.<ts>`; intent-before-destructive-write | No provider slot exists. Re-derived as an **extension hook set** writing to the **Continual Harness** (`memory` kind), registered by adding one absolute path to `settings.json.extensions`; ownership + reversal contract preserved verbatim | **v1**, mechanism invented (§Q2) |
| **2. Tool surface** | ~30 `dkg_*` schemas from `get_tool_schemas()` / `handle_tool_call()` | **Python-backed `dkg` kernel skill** (`import dkg; await dkg.query(...)`) as the primary surface, plus **3 `pi.registerTool()` lifecycle tools** for status/connect/health | **v1**, both (§Q3) |
| **3. Chat bridge** | Daemon forwards Node UI chat to Hermes' OpenAI-compatible server on `127.0.0.1:8642` | **Extension-hosted loopback HTTP bridge** — `/health`, `/send`, `/stream` — feeding `pi.sendUserMessage(..., { deliverAs })` and streaming `pi.on("message_update")` back as SSE | **v1** (§Q1, ADR 0007) |

---

## Q1 — Chat transport

### Recommendation: (a) extension-hosted loopback HTTP bridge

Full reasoning and the scoring matrix live in
[`.ai/adr/0007-prime-agent-adapter-transport.md`](../../../.ai/adr/0007-prime-agent-adapter-transport.md).
Summary of why it wins:

- **It is the only option that attaches to a running session without touching an
  unstable wire protocol.** Extensions load via
  `jiti.import(extensionPath, { default: true })` inside the process that owns
  execution — the daemon *worker* for a resident session
  (`src/core/extensions/loader.ts:331-351`; `docs/daemon.md:23-27`).
- **Extensions have unrestricted Node access.** *"Extensions run with your full
  system permissions and can execute arbitrary code"* (`docs/extensions.md:110`);
  *"Node.js built-ins (`node:fs`, `node:path`, etc.) are also available"*
  (`:153`). There is no allowlist in the loader; `VIRTUAL_MODULES`
  (`src/core/extensions/bundled-modules.ts:22-39`) only re-maps five packages so
  bundled builds share instances.
- **In-tree precedent for exactly this pattern.**
  `examples/extensions/file-trigger.ts:1-9` — *"Watches a trigger file and
  injects its contents into the conversation. Useful for external systems to
  send messages to the agent."* It calls
  `pi.sendMessage({...}, { triggerTurn: true })` (`:18-34`). Swapping `fs.watch`
  for `http.createServer` is strictly less exotic than what already ships in
  `examples/`.
- **Inbound**: `pi.sendUserMessage(content, { deliverAs: "followUp" })`
  (`src/core/extensions/types.ts:1135-1138`) — *"sends an actual user message
  that appears as if typed by the user. Always triggers a turn"*
  (`docs/extensions.md:1292-1314`).
  The bridge rejects new requests while an agent turn is observed active. The
  explicit follow-up mode handles the remaining admission race without steering
  or interrupting a locally-started turn.
- **Outbound**: `pi.on("message_update", ...)` carries
  `assistantMessageEvent`, the token-by-token stream event
  (`types.ts:683`; `docs/extensions.md:541-544`), plus `agent_start`/`agent_end`
  (`types.ts:638,643`) and `turn_start`/`turn_end` (`:662,669`) for framing.
- **It lands on a contract the DKG daemon already implements.**
  `getHermesChannelTargets` derives `${base}/send`, `${base}/stream`,
  `${base}/health` (`packages/cli/src/daemon/hermes.ts:211-222`);
  `ensureHermesBridgeAvailable` pre-gates each send (`:529-537`);
  `buildHermesChannelHeaders` attaches `x-dkg-bridge-token` only for loopback
  bridge targets (`:269-276`); `pipeHermesStream` byte-passes SSE with
  backpressure (`:781-786`). The new daemon module is a near-copy, not a new
  design.

### Rejected alternatives, with concrete failure modes

**(b) `--mode rpc` and (c) `--mode acp` — they spawn, they do not attach.**
Both route through `createDaemonClientConnection({ clientOwned: true })`
(`src/main.ts:1512-1519`), and the "reuse an already-active session" branch is
gated `&& !options.clientOwned` (`src/main.ts:968`), so they always fall through
to `create` with `lifecycle: "client_owned"` (`:983-991`). Pointing one at a
session file a resident worker already owns yields `SessionAlreadyActiveError`
and exit 1 (`src/main.ts:1520-1526`; server error code `session_already_active`
at `daemon-protocol.ts:757`). *Failure mode:* the Node UI would be talking to a
second, empty agent that shares none of the user's live context. ACP is worse
still: `loadSession: false` (`src/modes/acp/acp-mode.ts:261`) and a second
`session/new` is refused outright (`:279-284`).

**(d) The daemon socket — attaches, but on a surface that disclaims itself.**
It is the only other real attach path (`attach`, `prompt`, `steer`,
`prompt_and_wait` — `daemon-protocol.ts:366-449`), and its recovery story is the
best in the repo (fsync'd `clientId+commandId` journal,
`command-recovery-journal.ts:44-46,174-184`). It loses on four counts:
1. *Self-disclaimed stability* — *"This is the transport used by
   DaemonAgentConnection today, **not the final remote gateway protocol**"*
   (`daemon-protocol.ts:42-49`); *"not promises of a stable public network
   schema"* (`docs/agent-connection.md:85`); already 4→7 with 13 schema
   revisions.
2. *No in-protocol auth* — `authenticated: true` unconditionally for every
   public-socket client (`daemon-supervisor.ts:1011`). Security is only the
   `0700` dir + `0600` socket (`daemon-socket.ts:7-8,233-235`), and the docs are
   explicit it is *"process coordination, not a sandbox boundary"*
   (`docs/daemon.md:120`). *Failure mode:* whoever can reach the socket can
   `shutdown`, `execute_bash`, `kill`.
3. *The CLI entry points were removed at this SHA* —
   `REMOVED_COMMAND_NAMES` includes `daemon` (`src/cli/command-registry.ts:159`),
   so `runPrompt`/`runJsonAttach` (`src/cli/daemon-command.ts:807-860`) are
   unreachable dead code. We would be speaking a private socket by hand.
4. *Replay is near-always unavailable* — any cursor gap returns
   `event_replay_not_available` (`daemon-protocol.ts:1132-1139`); snapshot is
   the recovery baseline (`docs/agent-connection.md:101`).

**(e) SDK `createAgentSession` — in-process only, and it breaks the boundary.**
It constructs `AuthStorage`, `ModelRegistry`, `SettingsManager`, `SessionManager`
and `McpManager` locally (`src/core/sdk.ts:155-185`); there is no transport
parameter. *"Direct SDK calls to print and RPC modes remain in-process"*
(`docs/daemon.md:55`), and supplying process-local extension factories
force-disables the daemon client path entirely (`src/main.ts:234`). *Failure
mode:* the DKG daemon becomes the agent host, owning model credentials, kernels
and session state — exactly the boundary `adapter-hermes` refuses to cross.

**(f) An existing HTTP server — does not exist.** Repo-wide, the only listening
sockets are `node:net` unix sockets (daemon supervisor
`daemon-supervisor.ts:662,731`; kernel fork server
`src/core/kernel/fork-server.ts:130,172`) and ephemeral OAuth loopback receivers
(`packages/ai/src/utils/oauth/*`, `packages/ai/src/mcp/oauth.ts`). No HTTP
framework appears in any workspace `package.json`.

### What would change my mind

If Prime Agent ships a supported, versioned local HTTP/gateway surface — the
`daemon-protocol.ts:42-49` comment openly anticipates *"a future gateway"* — the
bridge should be retired in its favour, because a first-party server removes our
per-session port problem (§Q7) and the extension-lifetime coupling.

---

## Q2 — Memory election and its reversal

### What "DKG is Prime Agent's primary memory" means here

There is no provider slot: `ExtensionAPI` has no memory registration method
(`src/core/extensions/types.ts:1031-1258`), and grepping `harness` in that file
returns only `refine_complete` doc comments (`:648,657`). Durable agent state is
the **Continual Harness**: kinds `prompt | memory | skill | subagent`
(`RefinementKind`, `src/core/refinement/refinement.ts:30`), persisted as
`harness_state.json` (`:278`) with a `refinements.jsonl` history (`:25`).

Election is therefore re-derived as a **hook set**:

| Hook | Signature evidence | Role |
| --- | --- | --- |
| `before_agent_start` | `types.ts:625-637`; result `{message?, systemPrompt?}` (`:956`), chained across handlers (`runner.ts:922-986`) | **Recall injection.** Query the bound Context Graph for relevant assertions and inject them as a message, and/or append a provenance-marked block to the system prompt. |
| `turn_end` | `TurnEndEvent {turnIndex, message, toolResults}` (`types.ts:669`), emitted `agent-session.ts:3665` | **Turn sync.** Write the completed turn to DKG Working Memory via the daemon (`persist-turn` equivalent). |
| `agent_end` | `types.ts:643`, emitted `agent-session.ts:3653` | Fallback boundary when a run ends without a clean final turn. |
| `session_shutdown` | `types.ts:553`; awaited by the runner (`runner.ts:178-187`) | **Flush.** Last chance to drain queued writes; it is awaited, so a bounded flush is safe here. |
| `context` | `ContextEvent {messages}` (`types.ts:606`), result replaces the array, chained, input `structuredClone`d (`runner.ts:856-886`) | **v2 — pruning with provenance.** Replace evicted history with DKG-backed references. Powerful and dangerous; not v1. |
| `session_before_compact` | `types.ts:537`; result `{cancel?, compaction?}` (`:971`) | **v2 — consolidation.** See §Q8. |

### Mirror, do not replace, the Harness `memory` kind

**Mirror.** Three reasons, all from source:

1. **Scope mismatch.** Harness entries default to **session-local** scope
   (`applyRefinementProposal` defaults `options.scope ?? "local"`,
   `refinement.ts:768`; `refineHarness` passes
   `options.global ? "global" : "local"`, `:1015`), landing in
   `~/.prime/agent/session-artifacts/<sessionId>/harness/`
   (`getLocalHarnessStateDir`, `:273-275`;
   `getSessionArtifactPath`, `src/core/session-manager.ts:346-348`). DKG has no
   session-local memory concept. Replacing local entries would silently promote
   private, per-session scratch state into a shared Context Graph.
2. **Harness writes are user-visible and evidence-backed.** `/refine` produces a
   plan the user sees, appends a session custom entry
   (`agent-session.ts:7834`), rebuilds the system prompt (`:7835-7836`) and emits
   `refine_complete` (`:7844-7850`). Hijacking that store breaks a UX contract we
   do not own.
3. **Concurrent writers.** The kernel-side Python store and the host both write
   `harness_state.json`; the host deliberately re-reads target state immediately
   before applying (`agent-session.ts:7803-7805`) and the Python side reloads on
   mtime change (`prime-agent-runtime/src/rlm/harness.py:186-196`). A third
   writer that is not part of that protocol is an obvious corruption source.

**Mechanism.** Mirror on the read side by *reading* merged state
(`loadHarnessState`, `refinement.ts:281`; `mergeHarnessStates`, `:326-343`) and
publishing `kind: "memory"` entries to DKG as assertions, tagged with their
`scope` so local-scope entries are marked non-shareable. Do **not** call
`saveHarnessState` from the adapter in v1. Harness `skill` and `subagent` kinds
are **v2** — they carry executable references
(`reference {type:"python", import…, callable}`, validated at
`refinement.ts:664-705`) whose semantics in a shared graph need their own design.

### What setup mutates, and the ownership contract

**File mutated: `settings.json`, key `extensions` (array of paths).**
`Settings.extensions?: string[]` — *"Local extension file paths or directories"*
(`src/core/settings-manager.ts:147-148`), accessor `getExtensionPaths()`
(`:959-961`).

**Absolute paths are confirmed to work**, which is what lets the adapter point at
its own `node_modules` copy rather than publishing a Prime Agent package:
`resolveLocalEntries` → `resolvePathFromBase` (`src/core/package-manager.ts:2124`,
`:1929-1935`) ends in `resolve(baseDir, trimmed)`, and `node:path.resolve` returns
an absolute input unchanged; `~` is expanded explicitly (`:1930-1932`). Confirmed
by test (`test/settings-manager.test.ts:114-127`, which asserts
`extensions: ["/local/ext.ts", "./relative/ext.ts"]` survive as-is) and by docs
(`docs/settings.md:210`).

**Managed-region equivalent.** `settings.json` is JSON, so Hermes' textual
BEGIN/END markers do not translate. Ownership is expressed instead as:

- a single adapter-owned entry appended to `settings.json.extensions`, pointing
  at an absolute path inside the adapter package;
- an adapter-owned state directory `~/.prime/agent/.dkg-adapter-prime-agent/`
  holding `setup-state.json` (mirroring `HermesSetupState`, including
  `managedBy`, `managedFiles`, `installedAt`, `updatedAt`);
- a `priorSettings` snapshot recorded **first-wins**, exactly like
  `priorMemoryProvider` (`packages/adapter-hermes/src/setup.ts:267-279,1315`).

**Ordering — unchanged from Hermes, and it still matters.** The
intent-before-destructive-write sequence
(`packages/adapter-hermes/README.md:168-184`; implementation `src/setup.ts:1336-1414`):

1. write `setup-state.json` containing `priorSettings { extensionsSnapshot,
   settingsBackupPath, capturedAt }` — **before** any destructive change;
2. write `settings.json.bak.<unix-ts-ms>` holding pre-change bytes verbatim;
3. rewrite `settings.json` adding the adapter's extension path.

SIGINT between any two steps stays recoverable: a re-run reads the persisted
snapshot and routes restore to the captured backup even if step 3 never
happened. Restore mirrors Hermes' two-path strategy: **surgical** first (remove
exactly our entry from the `extensions` array, leaving unrelated user edits
intact), **atomic rename of the backup** as fallback, then verify the array no
longer contains our path — mismatch ⇒ `path: 'failed'`
(`packages/adapter-hermes/src/types.ts:161-174`). Restore failure must not roll
back disconnect (`adapter-hermes/README.md:190-192`).

**One asymmetry worth stating.** Hermes' `priorMemoryProvider` captures a single
scalar. Ours captures an array the user may edit between setup and disconnect,
so surgical restore is *entry removal*, never wholesale array replacement.

---

## Q3 — Tool surface shape

### Recommendation: (iii) both — a Python-backed `dkg` kernel skill, plus three lifecycle tools

**Why the kernel skill is the primary surface.** Prime Agent's tool model is
deliberately singular: `allToolNames = new Set(["ipython"])`
(`src/core/tools/index.ts:46-47`), and the MCP doc states the design intent
directly — integrations are Python-backed skills the model imports and calls
inside the kernel, *not* agent tools (`docs/mcp-integrations.md:6-13`). Building
~30 `registerTool` schemas would fight the host's idiom and bloat every provider
request with tool JSON (`parameters` is passed verbatim into `context.tools`,
`packages/agent/src/agent-loop.ts:511`).

**The skill package contract is precise and cheap to satisfy** — all four
conditions from `src/core/skills.ts:202-254`:

1. `SKILL.md` present;
2. `pyproject.toml` at the skill root (its presence is the marker, `:207-218`);
3. import name = skill name with `-`→`_`, matching `/^[A-Za-z_][A-Za-z0-9_]*$/`
   (`:194-200`);
4. `src/<import_name>/__init__.py` exists — exact src layout (`:230-247`).

Skills install editable into the kernel venv
(`formatPythonSkillInstallArgs` → `["--editable", packagePath]`,
`src/core/kernel/bootstrap.ts:325-327`), are reinstalled only when
`pyproject.toml`'s hash changes (`:778-782`), and a module exposing a callable
`run` becomes directly awaitable — `await dkg(...)` — via
`_prime_agent_wrap_skill_module` (`src/core/tools/ipython.ts:108-125`). Import
failure degrades to a placeholder that raises with the original error
(`:89-106`), so a broken DKG skill cannot take down the kernel.

**Why three `registerTool` tools anyway.** Lifecycle and status must work even
when the kernel is cold or the skill failed to install. `registerTool`
(`types.ts:1081`; impl `loader.ts:183-190`) has no numeric cap — greps for
`MAX_TOOLS`/`too many tools` across `packages/coding-agent/src`,
`packages/agent/src`, `packages/ai/src` return nothing — so a *small* set is
free. Proposed: `dkg_status`, `dkg_connect_info`, `dkg_health`. Everything
model-facing and data-shaped stays in the kernel skill.

### Consequence for `packages/cli/skills/dkg-node/SKILL.md`

**Both — copied and rewritten.** The file is 973 lines of tool-surface truth
written for a `dkg_*` tool-call convention. Prime Agent's skill loader expects a
`SKILL.md` at the package root as its discovery marker (`skills.ts:202-210`), so
the adapter ships a **rewritten** `SKILL.md` whose examples use the kernel
convention (`import dkg; await dkg.query(...)`) while preserving the node
skill's semantics, guardrails and vocabulary. The upstream file remains the
source of truth for *what* the surface does; the rewrite is a calling-convention
translation, and drift between them is a documented risk (RISKS.md). Copying it
verbatim would teach the model a tool-call syntax that does not exist in this
host.

---

## Q4 — Is the MCP path actually available?

### Recommendation: not for v1. It is real, but it is a second server surface.

**The blocker is confirmed.** `packages/mcp-dkg` constructs a
`StdioServerTransport` and has no HTTP transport. Prime Agent's host drops
non-HTTP entries with a one-line filter:

```ts
if (config.type !== "http") continue; // stdio servers self-manage in Python
```
`src/core/mcp/mcp-manager.ts:73`

Consequently a `type: "stdio"` server never becomes a `ResolvedIntegration`, so
it gets no OAuth registration (`:98-124`), no `mcp.config` for the kernel
(`:170-180`), and no `/mcp` status row (`:197-204`). The Python client ships only
streamable HTTP (`prime-agent-runtime/src/rlm/mcp_base.py:206-244`). Docs
concur: *"stdio (local-subprocess) servers are not yet wired through to the
kernel — the host drops non-HTTP entries"* (`docs/mcp-integrations.md:109-110`).

**Auth is the easy part, and cheaper than feared.** `bearerTokenEnvVar` alone
enables an integration —
`if (integration.bearerTokenEnvVar && process.env[...]?.trim()) return true;`
(`mcp-manager.ts:129-131`) — so pointing it at the node's `auth.token` value
works without OAuth. OAuth would require RFC 7591 dynamic client registration;
pre-registered client ids are unsupported (`docs/mcp-integrations.md:170-174`),
so **OAuth DCR is correctly ruled out**.

**Why still not v1.** Adding Streamable HTTP to the DKG daemon (or a shim in
front of `packages/mcp-dkg`) is a genuinely attractive, reusable asset — it would
serve any HTTP-MCP client, not just Prime Agent. But it is a *new authenticated
network surface on the node*, with its own auth, scoping and guard story, landing
in a different package from this adapter. The kernel-skill path reaches the same
model-facing capability with no new node surface and no new attack surface.

**Does it make Q3 moot?** **No — it would replace only the data-plane half.**
Even with HTTP MCP, integrations surface as Python skills, not tools
(`docs/mcp-integrations.md:6-13`), so the calling convention the model sees is
unchanged; and the lifecycle/status tools remain, since MCP has nothing to say
about adapter connect state. It is a **v2 substitution for the `dkg` skill's
transport**, not a replacement for the design.

---

## Q5 — Packaging and language split

**What the package ships**

```
packages/adapter-prime-agent/
  src/…                    TypeScript: types, setup verbs, daemon client, plugin
  setup-entry.mjs          lazy setup-safe entry (mode gate + lazy re-exports)
  extension/dist/extension.js   the Prime Agent extension (bridge host)
  dkg-skill/               Python kernel skill package
    SKILL.md
    pyproject.toml
    src/dkg/__init__.py
```

**Absolute-path loading is confirmed** (chain cited in §Q2), so
`settings.json.extensions` can point directly at
`…/node_modules/@origintrail-official/dkg-adapter-prime-agent/extension/dist/extension.js`.
**No Prime Agent npm/git package is required.**

**Beware the `packages` key.** `parseSource` treats only `npm:`, `git:`,
`github:`, `http:`, `https:`, `ssh:` prefixes as remote; **everything else,
including bare names, resolves as a local path**
(`src/core/package-manager.ts:1385-1408`; `isLocalPath`
`src/utils/paths.ts:23-37`; test `test/package-manager.test.ts:857-861`). The
docs show `"packages": ["pi-skills", "@org/my-extension"]` as npm form
(`docs/settings.md:239-244`), which contradicts the code. **Use `extensions`,
not `packages`** — it is unambiguous.

**jiti constrains almost nothing.** `loadExtensionModule` calls
`jiti.import(extensionPath, { default: true })` with `moduleCache: false`
(`loader.ts:336-351`), so either TS or JS loads and the default export must be a
function. Shipping **plain JS** avoids any jiti/TS-transform coupling; a compiled
single-file `extension.js` is the safest artifact. Directory entries resolve via
`package.json` `pi.extensions` → `index.ts` → `index.js` (`loader.ts:480-510`),
which we do not need if we point at the file directly.

**`dependencies` vs `devDependencies` does not affect us**, because we are not
installed *as* a Prime Agent package — the extension is loaded from an absolute
path and the Python skill is installed editable into the kernel venv from its own
`pyproject.toml` (`bootstrap.ts:325-327,803-811`).

---

## Q6 — Turn identity and idempotency

Because Q1 selects the extension bridge, **the daemon's `{generation, sequence}`
cursors are not on our path** — those belong to the socket protocol we are not
speaking. Identity must be re-derived from what the extension can see.

**Turn id.** Reuse `buildStableHermesTurnId`
(`packages/cli/src/daemon/hermes.ts:654-674`) unchanged. Its discriminator is
`idempotencyKey ?? correlationId ?? nonce`, and **with no discriminator it falls
back to `hermes-${randomUUID()}`** (`:663`) — i.e. non-idempotent. The bridge
must therefore always echo the daemon's `correlationId` back, since the daemon
already generates one per send (`routes/hermes.ts:567-580`). Hash inputs are
`{sessionId, discriminator, profile, contextGraphId}` (`:665-674`).

**`sessionId`.** Use Prime Agent's active session id, which the extension can
read from its context, and which must be included so that two sessions cannot
collide on the same `correlationId`.

**Duplicate protection** is unchanged and daemon-side: `hasPersistedHermesTurn`
(`:681-686`), the in-flight map keyed by `hermesPersistTurnKey` = `sessionId\nturnId`
(`routes/hermes.ts:844-874`), and the state rank `stored(3) > failed(2)`
(`:958-960`).

**Scenario table**

| Event | Prime Agent behavior (cited) | Adapter consequence |
| --- | --- | --- |
| **Worker crash mid-turn** | Supervisor retries `[250, 1000, 5000] ms` (`daemon-supervisor.ts:136`), reaps uncertain operations without replaying side effects, and appends a visible recovery marker (`docs/daemon.md:142`) | The extension dies with the worker, so the bridge port disappears; the daemon's `ensureHermesBridgeAvailable` returns offline and the send fails closed. On respawn the extension re-registers and re-publishes its port. **No half-written turn**: we only persist on `turn_end`. |
| **Supervisor replacement** | New `supervisorGeneration` (`daemon-supervisor.ts:600`), live workers adopted (`:688-702`) | Invisible to us — we never speak the socket. Bridge stays bound because the *worker* survived. |
| **Session fork** | `session_before_fork` may veto (`types.ts:530`; result `:966`); a fork shares a history prefix | **The interesting case.** Fork produces a new session id, so turn ids diverge from the fork point — correct. Turns *before* the fork are already persisted under the parent's id and must not be re-persisted; the extension must not replay history on `session_start` with `reason: "fork"` (`types.ts:514`). |
| **Session clone** | same shape as fork | Identical handling; treat `reason` values `"fork"` and `"resume"` as "do not backfill". |
| **Tree navigation** | `session_before_tree` / `session_tree` (`types.ts:576,583`) | Navigation changes the visible branch, not the durable turn record. Ignore in v1; persisting branch structure is v2. |
| **Compaction** | `session_before_compact` (`types.ts:537`), `session_compact` (`:546`) | Turns already persisted are unaffected — compaction rewrites context, not history-of-record. See §Q8 for turning this into an opportunity. |

---

## Q7 — Multi-session identity

**This is the design's one genuinely new problem.** Hermes assumes ~one profile
per agent. Prime Agent runs one resident worker per **root session tree**
(`docs/daemon.md:23-27`), each loading its own extension instance — so **each
live session binds its own bridge port**.

**Recommendation: one registry record for the installation, plus a
session-discovery file.**

- **Registry**: a single `LOCAL_AGENT_INTEGRATION_DEFINITIONS` entry with
  `id: 'prime-agent'` (shape at `packages/cli/src/daemon/local-agents.ts:72-79`;
  hermes/openclaw entries `:93-131`). Per-session registry records would make the
  Connected Agents panel churn on every session open/close and would need
  dynamic definition keys, which `listLocalAgentIntegrations` (`:302-308`) and
  the refresh route (`routes/local-agents.ts:400-408`) do not support.
- **Discovery**: the extension writes
  `~/.prime/agent/.dkg-adapter-prime-agent/sessions/<sessionId>.json`
  (`{ sessionId, bridgeUrl, pid, startedAt, lastActiveAt?, sessionName? }`) on `session_start` and
  removes it on `session_shutdown` (both hooks exist and shutdown is awaited —
  `types.ts:514,553`; `runner.ts:178-187`). The daemon resolves the active
  bridge by reading that directory, ignoring entries whose `pid` is gone.
- **Selection**: the transport's `bridgeUrl` becomes *derived*, not static. The
  UI names a session; the daemon maps it to a port. When exactly one session is
  live, the choice is automatic — which is the common case and keeps parity with
  the Hermes UX.

**Subagents.** RLM subagents spawned under a root tree are *not* separate
integrations: they share the worker and its extension instance. Map them to
**sub-graphs within the session's Context Graph**, tagged with the subagent
identity, so provenance survives without multiplying graphs. Separate assertions
per subagent, same graph.

**What the Connected Agents panel shows with three live sessions:** one
"Prime Agent" row (installation-level: configured/ready/degraded), with a session
count and a selector. Rendering three peer rows would imply three independently
connectable integrations, which is false — they share one settings file, one
extension install, and one harness global scope.

---

## Q8 — Compaction as an opportunity

**Recommendation: documented v2, with the hook reserved in v1.**

The capability is real and unusually well-suited: `session_before_compact`
receives `{ preparation, branchEntries, customInstructions?, signal }`
(`types.ts:537`) and its result may **veto or wholly replace** the compaction
output — `{ cancel?, compaction?: CompactionResult }` (`:971`), dispatched with
short-circuit semantics (`runner.ts:690-694`). Compaction is precisely the moment
when context is about to be discarded, so consolidating it into DKG Working
Memory — and replacing it with a summary that *cites* the resulting assertions —
converts a lossy operation into a provenance-preserving one. Hermes has no
equivalent hook.

**Why not v1.** Replacing a `CompactionResult` puts the adapter on the critical
path of the agent's context management: a slow DKG write stalls compaction, and a
bad summary silently degrades every subsequent turn. It also interacts with
auto-refine, which can fire on `compact` (`AutoRefineReason = "turn_interval" |
"compact"`, `refinement.ts:110`; settings `settings-manager.ts:23-28`).

**Cost estimate.** Small in code, large in testing: one handler plus a
summary-composition path (~150–250 LOC), but it needs deterministic tests for
veto, timeout, DKG-unavailable, and oversized-branch cases, plus a golden test
that the produced summary keeps citations resolvable. Budget one full stage.

**v1 obligation:** register a no-op `session_before_compact` handler that returns
nothing, so the wiring and its tests exist before behavior is added.

---

## Q9 — Guard parity

**The governing fact:** Prime Agent executes model-generated Python in a
persistent kernel with the user's own permissions, and extensions likewise run
with *"your full system permissions"* (`docs/extensions.md:110`); the daemon docs
state plainly it is *"not a sandbox boundary: all processes still run as the same
OS user"* (`docs/daemon.md:120`). **Therefore every publish-exposure default must
be at least as conservative as Hermes', and the direct-publish default is
non-negotiable.**

| Hermes control | Decision | Mechanism |
| --- | --- | --- |
| `allow_direct_publish` / `DKG_ALLOW_DIRECT_PUBLISH` (default `false`) | **Reproduce, hard-default `false`** | Adapter config in `~/.prime/agent/.dkg-adapter-prime-agent/dkg.json`; the kernel skill reads it per call, never caches a permissive value. Rationale above makes this stricter than Hermes in spirit: the model can write arbitrary Python, so a publish path must be gated by the node, not by the agent. |
| `allow_context_graph_admin_tools` (default `false`) | **Reproduce** | Same config; admin operations absent from the skill surface unless enabled. |
| `import_roots` with operator-approved roots | **Reproduce** | Same config; the skill refuses paths outside approved roots. Especially important here — the kernel has filesystem access by construction. |
| Loopback-only bridge URL validation | **Reproduce, unchanged** | Both layers already exist daemon-side: setup-time throw (`adapter-hermes/src/setup.ts:1142-1144`) and runtime drop (`packages/cli/src/daemon/hermes.ts:211`), plus the per-request re-check in `buildHermesChannelHeaders` (`:272`). The extension binds `127.0.0.1` explicitly. |
| Fail-closed `send`/`stream` when the integration is disabled | **Reproduce** | Daemon-side gate copied from `routes/hermes.ts:192,324` (409 `INTEGRATION_DISABLED`). Note `persist-turn` deliberately has **no** such gate (`:523`) — preserve that asymmetry. |
| Attachment provenance verification | **Reproduce** | Reuse `verifyHermesAttachmentRefsProvenance` (`hermes.ts:765-770`), which already delegates to the OpenClaw implementation — no fork. |
| `x-dkg-bridge-token` verification server-side | **Reproduce** | Model on `authorizeBridgeRequest` (`packages/adapter-openclaw/src/DkgChannelPlugin.ts:2553-2570`): `503` when the adapter has no expected token, `401` on mismatch. **Improve on it:** use a timing-safe comparison; the reference uses `!==`. |
| — | **New guard** | The bridge must bind loopback only and refuse requests whose `Host`/origin is not loopback, because unlike Hermes there is no upstream server enforcing anything. |

---

## Q10 — Naming and licensing

| Item | Choice | Rationale |
| --- | --- | --- |
| Package | `packages/adapter-prime-agent`, npm `@origintrail-official/dkg-adapter-prime-agent` | Matches the upstream product name (`prime-agent`, `docs/*`) and the existing `adapter-<agent>` convention. `adapter-prime-intellect` names the company, not the agent; `adapter-pi` collides with the upstream `pi` lineage and reads as an abbreviation. |
| Integration id | `prime-agent` | Used as the `LOCAL_AGENT_INTEGRATION_DEFINITIONS` key and in route branches. |
| CLI verb | `dkg prime-agent setup|verify|status|doctor|disconnect|reconnect|uninstall` | Mirrors `dkg hermes …` exactly (`packages/cli/src/commands/hermes.ts`). |
| `transportKind` | `prime-agent-channel` | `transport.kind` is an unconstrained `string` (`packages/cli/src/config.ts:388-393`), so **no `config.ts` change is required** — only the definition entry and the routing branches. |

**Licensing.** DKG is Apache-2.0; prime-agent is MIT (`/tmp/prime-agent/LICENSE`).
MIT→Apache-2.0 inclusion is permitted with attribution, so vendoring would be
*legal* — but the design **vendors nothing**: the extension is our own code
against a documented API, and the skill is our own Python. If any prime-agent
schema or snippet is later copied, it must carry MIT attribution in a `NOTICE`
or file header.

**`@earendil-works/pi-coding-agent` types.** Do **not** take a runtime
dependency. If `ExtensionAPI` types are wanted for authoring, vendor a minimal
local `.d.ts` of only the members we call, or import types-only under
`devDependencies`. Reasons: the upstream lineage is a third-party project
(`pi`/pi-mono), the loader re-maps those packages through `VIRTUAL_MODULES`
(`src/core/extensions/bundled-modules.ts:22-39`) so runtime identity is
host-controlled, and a runtime dep would pull an agent runtime into a DKG package
for no benefit.

---

## Open questions and unverified items

1. **UNVERIFIED — the extension's own session id.** The design requires the
   extension to know its active session id for turn identity (§Q6) and the
   discovery file (§Q7). `ExtensionContext` (`types.ts:291-320`) was read but the
   exact field exposing session identity was not confirmed at `path:line`. If it
   is absent, the fallback is `pi.getSessionName()` (`types.ts:1151`) plus the
   session-artifact directory path, or an id minted by the extension and recorded
   in the discovery file. **This must be resolved before Stage 1 ships.**
2. **UNVERIFIED — extension load timing vs. port binding.** Whether an extension
   can bind a port during load or must wait for `session_start` was not
   confirmed; `refreshTools` is documented as a no-op pre-bind
   (`loader.ts:136-137`), which hints at a two-phase lifecycle.
3. **Port allocation policy.** Ephemeral port + discovery file is proposed; a
   fixed base port with per-session offset is the alternative. Needs a decision
   with the daemon-side reader.
4. **Node UI session selector.** §Q7 assumes the panel can express "one
   integration, N sessions". The exact component change is scoped in
   IMPLEMENTATION-PLAN.md but the UX has not been reviewed.
5. **Harness read cadence.** How often to mirror `memory` entries into DKG —
   on `refine_complete` (`types.ts:649`) is the obvious trigger, but auto-refine
   can fire every 25 turns by default (`settings-manager.ts:23-28`).
