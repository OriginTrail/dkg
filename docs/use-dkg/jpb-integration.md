# JPB DKG integration consolidation

JPB has used a pinned Graph Computer/editor build with selected runtime and UI
overlays. This change brings the DKG fixes into one review branch, including the
four patches previously stored only in `OriginTrail/jbp_digital_twin`. The SQL
worker, mapping, query definitions, PLCA calculation and domain adapters remain
in that repository.

## Review base and included changes

The base is `codex/dmaast-program-editor-deploy-20260921`, pinned during this
consolidation at `ba0d433d84ae9a77e17991f1e637a6bb50c0ca04`. It already includes
the reviewed domain-adapter loading from #3055 and the Node 26 chain transport
fix from #3142. The consolidation preserves those changes and the existing
Graph Computer/editor prerequisites. It is not a standalone backport to main.

| Source | Included behavior |
| --- | --- |
| [#3033](https://github.com/OriginTrail/dkg/pull/3033) | Immutable, hash-bound TypeScript source bundles; pure library imports without host filesystem or network access; dependency editing in the Program editor. |
| [#3068](https://github.com/OriginTrail/dkg/pull/3068) | Native scoped LLM invocation from approved Programs, configuration and adapter pins, session ownership, cancellation, effect receipts and revocation checks. |
| [#3080](https://github.com/OriginTrail/dkg/pull/3080) | Chat and Program requests work on private HTTP node URLs; early failures reach the UI. |
| [#3092](https://github.com/OriginTrail/dkg/pull/3092) | Targeted Context Graph authority reads for operators and a graph's authenticated curator. |
| [#3196](https://github.com/OriginTrail/dkg/pull/3196) | Explicit model context-overflow recovery without repeating completed tools, required-domain-tool checks and catalog filtering before loading historical generations. |
| `private-local-first-write-50acc958.patch` | Authorized first writes to node-created private graphs without enabling gossip or accepting replicated RDF as local provenance. |
| `monitoring-runtime-50acc958.patch` | Chunked large execution receipts with exact, isolated readback; approval quotas scoped to each Context Graph. |
| `wm-default-dataset-50acc958.patch` | Authorized Working Memory joins between separate KAs, using the resolved graph/agent allow-set. |
| `jpb-monitoring-50acc958.patch` | Native Sources controls, one shared data graph, SQL coverage/absence display, fetch receipts, bounded notification fanout and one refresh in flight. |

Original PR commits remain in the branch history. Patch changes have separate
commits. The only source conflict required retaining both the LLM adapter and
execution-output codec imports in `semantic-runtime.ts`.

## What runs where

```mermaid
sequenceDiagram
    actor User
    participant UI as DKG UI
    participant DKG as DKG daemon
    participant JPB as JPB route plugin and SQL worker
    participant SQL as JPB SQL Server
    participant GC as Graph Computer
    participant LLM as Scoped LLM and domain adapter

    User->>UI: Configure monitored orders
    UI->>DKG: Authenticated monitoring request
    DKG->>JPB: Owner/operator-scoped route plugin
    JPB->>GC: Invoke shared fetch-request Program
    GC-->>JPB: Native request execution receipt
    loop Internal SQL checkpoint batches
        JPB->>SQL: Read configured order scope
        SQL-->>JPB: Source records or explicit missing orders
        JPB->>DKG: Write/reuse private data KAs in shared graph
        DKG-->>JPB: Sealed asset readback
    end
    JPB->>DKG: Commit current view and fetch result
    User->>UI: Ask about monitored orders
    UI->>DKG: Authenticated chat request
    DKG->>GC: Invoke approved chat Program
    GC->>LLM: Authorized native llm/safe effect
    LLM->>DKG: Scoped catalog queries via domain adapter
    DKG-->>LLM: Current results, sources and freshness
    LLM-->>GC: Answer and evidence
    GC->>DKG: Persist private execution KA and effect receipt
    DKG-->>UI: Answer and native execution reference
```

The host worker performs SQL I/O and schedules refreshes after completion.
The shared fetch Program accepts and records the request; SQL does not run
inside its Wasm guest. Automatic post-ingest PLCA currently runs host-side
preparation/calculation helpers and writes result KAs. This consolidation does
not turn every host-side workflow step into a Graph Computer Program.

The Sources page uses the JPB route plugin's `/api/jpb-monitor` endpoints.
The plugin, worker and reviewed adapter/profile must still be installed and
configured separately. DKG credentials and SQL credentials are not sent to
the model. Private graph authorization, read-only model tools, Program grants
and configuration pins remain enforced.

## Validation and deployed state

The accompanying [validation receipt](jpb-dkg-consolidation-20261013.json) records source coverage,
local checks and the live source comparison. The `JPB DKG integration` workflow
runs the combined regression suites on this feature-base PR; normal protected
branch CI still applies when the changes are proposed to a protected branch.

Local validation uses Node 25.2.1 and pnpm 10.28.1. For the browser test lane,
`NODE_OPTIONS=--no-experimental-webstorage` prevents Node's experimental storage
global from replacing the browser test environment's storage. Native Rust/Wasm
artifacts are reused locally only after verifying the identical checked-in
artifact lock, every artifact hash and the ABI. Hosted integration CI builds
them from the pinned Rust source/toolchain instead.

All **997 targeted checks in 58 test files** pass: 295 CLI, 119 local-LLM,
410 query, 109 UI, 24 semantic-runtime, 34 SDK, three source-bundle and three
MCP-adapter tests. The CLI dependency TypeScript build, production UI build,
workflow parsing, NUL-byte audit and diff whitespace checks also pass.
The native CLI cases exercise Wasm execution, receipts, approval/revocation
and replay; model responses in these regression tests are fixtures.

Repository-wide lint is not green on the prerequisite branch: seven oxlint
fingerprints and four expired/incomplete test-exception declarations remain.
An isolated checkout of the untouched base produced byte-identical oxlint
diagnostics and the same disabled-test audit (64 existing findings, zero
additions). This consolidation adds no lint findings and does not change those
unrelated exceptions. The chain-backed notification suite requires its
Hardhat/global-setup lane; the targeted lane here checks the authenticated,
bounded notification fanout without starting a chain.

This consolidation does not deploy or restart JPB. The node remains based on
`50acc9581297910065b272d1827b2f7649cae1b7` with selected overlays, including the
LLM/catalog files from `766f601693ecb0a698a4c074b1ee6decf3646831`. Source inspection
confirmed the private-write, receipt, quota, Working Memory, authority,
notification and LLM/catalog overlays. The live compiler does not yet have the
immutable bundle implementation from #3033. The live Sources source is also
older than the consolidated coverage/absence display. A whole-branch runtime
or UI deployment is not implied by earlier overlay deployments.

The worker shutdown/recovery fix remains in
[JPB #20](https://github.com/OriginTrail/jbp_digital_twin/pull/20), with deployed
runtime commit `9e823207538e47f5bbfd3024707187d283057080`. Full recovered-cycle and
next automatic-refresh verification is a separate, ongoing check. Local DKG
tests do not prove that operational check completed. SQL coverage also does
not establish complete lot genealogy or measured PLCA impacts.

## Future rollout

1. Build the reviewed combined commit and retain the existing runtime/static
   assets and private state backups. Preserve graph data, approvals, source
   checkpoints, SQL grants, the order watchlist and the schedule.
2. Install the existing JPB route plugin and reviewed adapter/profile against
   that build. Compare configured grants and Program source/configuration
   digests before activation; bundle changes require renewed source approval.
3. Switch the runtime and production UI during an agreed worker pause. Reuse
   the worker's durable checkpoints on resume. No graph deletion or RDF schema
   migration is required by this DKG consolidation.
4. Verify authorized private writes/readback, catalog cross-KA queries,
   Program-backed LLM execution/replay and Sources coverage. Check unauthorized
   and foreign-graph rejection. Then observe the scheduled refresh and unchanged
   asset/checkpoint identities independently.

The historical patch files remain useful as deployment provenance. An operator
must not apply them again over this combined source tree.
