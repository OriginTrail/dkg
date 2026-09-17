# DKG semantic runtime

This package contains the default-off TypeScript host and shared Rust semantic
kernel for DKG V10. Program S-expressions remain RDF data; every invocation
loads and admits one immutable Program plan into the same kernel.

The execution boundary is a versioned WebAssembly component with typed,
asynchronous WIT. The official Rust WASI 0.3 build flow uses a
`wasm32-wasip2` carrier component plus async component-model bindings rather
than a Rust `wasm32-wasip3` target. This repository pins nightly
`2026-08-18`, `wit-bindgen` 0.61.1, and jco 1.32.1. See
[`docs/architecture/semantic-runtime-wasi-0.3.md`](../../docs/architecture/semantic-runtime-wasi-0.3.md).

Run `pnpm build:semantic-runtime` from a source checkout. It builds the
gitignored local artifacts, validates their WIT world and bounded memories, and
requires them to match `artifact-lock.json`. Generated Wasm and JavaScript glue
are packaged in npm but are not stored in Git.

The Wasm build normalizes source paths, compiler metadata, and Rust archive
member names so the pinned artifacts can be reproduced on different hosts.
The compiler wrapper works around
[Cargo's host-dependent metadata issue](https://github.com/rust-lang/cargo/issues/8140)
and the resulting archive names, which Rust uses to order link-time optimization
inputs. Cargo's outer cache filenames and compiled object contents are preserved,
as are the artifact hash checks. Custom `RUSTFLAGS`,
`CARGO_ENCODED_RUSTFLAGS`, `RUSTC_WRAPPER`, and `RUSTC_WORKSPACE_WRAPPER` values
are rejected; clear them before running this pinned build.

Executing or admitting Programs requires a Node.js runtime with native
WebAssembly JavaScript Promise Integration (JSPI); use **Node.js 26.8.2 or newer**,
which is also the version exercised by the semantic runtime CI lanes.
The default DKG installation
and artifact build still support the repository's Node.js 22 baseline; opt-in
semantic runtime deployments must use the newer Node.js executable. Node.js 22
does not expose the required `WebAssembly.Suspending` and `WebAssembly.promising`
APIs, even with its experimental JSPI flag. Startup checks these APIs before
creating a runtime partition, and direct admission checks them before creating
a component Worker. No V8 flags are enabled automatically.

The packaged component owns bounded S-expression parsing, deterministic plan
compilation, and canonical-plan re-admission. Compilation uses a disposable
component Worker. Each active execution then has its own component instance and
Worker, with an ordered per-execution queue and a bounded global execution
count. A timeout, trap, or memory failure terminates only that execution
partition.

The host-side V1 modules provide:

- a dedicated WAL/FULL SQLite event, snapshot, capability, approval,
  authorization, and effect journal;
- a closed adapter registry and prepared-effect gateway with current-policy and
  capability rechecks;
- explicit `unknown` outcomes and read-only reconciliation rather than blind
  mutation retry;
- trusted graph-trigger activation pinned to graph revision, policy epoch,
  signature, review state, and Wasm-admitted plan semantics; and
- allowlisted DKG provenance projection that excludes mailboxes, normalized
  inputs, credentials, and opaque capability identifiers.

The CLI integration remains deliberately conservative: its exact opt-in starts
the integrity/watchdog/recovery partition, but it does not automatically enable
graph trigger intake or register consequential production adapters. Deployments
must supply those trusted host dependencies explicitly. The runtime makes no
general exactly-once claim; ambiguous protected effects remain blocked until
their adapter reconciles them.

The daemon integration is opt-in:

```json
{
  "semanticRuntime": {
    "enabled": true,
    "watchdogMs": 100
  }
}
```

When enabled, a missing or modified local artifact, build-lock mismatch,
unexpected component import/export, incompatible ABI, failed Worker handshake,
or restore mismatch fails closed. Carrier WASI imports receive deny-only stubs:
the component receives no filesystem, network, environment, stdio, random, or
clock authority. Its repository-owned imports are an opaque, host-created
execution capability and four explicit typed tool interfaces.

Programs are stored in the DKG as `sr:Program` resources with `sr:language`,
`sr:version`, and `sr:source` triples. The authenticated
`POST /api/programs/execute` route loads a program by IRI from the
explicitly selected WM, SWM, or VM view of the requested context graph, admits
its S-expression in Wasm, and executes its logical agents there. The caller
also explicitly selects the Execution KA's target layer. The narrow execution
slice supports ordered `emit` forms and one typed tool request per delegate:
`agent/investigate@1`, `dkg/query@1`, `remote-execute@1`, or `llm/safe@1`. The
host performs only the requested operation and returns its result to the
waiting Wasm process.

`llm/safe@1` runs a native Rust Rig loop whose only tools are zero-argument
Programs explicitly named by the parent Program's `sr:permitsProgram` triples.
The model receives opaque generated tool names, never a Program IRI or a
general query/network interface:

```turtle
<urn:sr:program:safe-agent>
    a sr:Program ;
    sr:requiresTool <urn:sr:tool:safe-llm-v1> ;
    sr:permitsProgram <urn:sr:program:field-a-read> .
```

```lisp
(delegate agent
  (grant llm.invoke.safe)
  (call llm/safe@1 "Read field A and summarize it."))
```

Every selected child runs through the existing Program invocation path and
must persist its own Execution before its result is returned to Rig. The
parent Execution persists the final model text and links each child Execution
with `prov:wasInformedBy`.

The author node can run this loop against its local OpenAI-compatible model
without an API key. `DKG_LLM_URL` may name either the chat-completions endpoint
or its `/v1` base URL; `DKG_LLM_MODEL` selects the model:

```bash
DKG_LLM_URL=http://127.0.0.1:8080/v1/chat/completions \
DKG_LLM_MODEL=qwen3-8b-q4-k-m \
pnpm dkg daemon-foreground-worker
```

Only loopback endpoints are accepted without credentials. A remote compatible
endpoint still requires `llm.apiKey` (or `DKG_LLM_API_KEY` when selected with
`DKG_LLM_URL`).

`remote-execute@1` composes Programs without exposing a network socket to the
component:

```lisp
(delegate composer
  (grant program.remote-execute)
  (call remote-execute@1 "12D3KooWTargetPeer" "urn:sr:program:child"))
```

The child inherits the parent Context Graph and selected Program/Execution
layers. The signing wallet never comes from the S-expression. Each executing
node signs the next target-bound DKG inbox delegation with its current operator
wallet. The target independently requires a private Context Graph and current
membership for that immediate caller before executing the replicated Program
as its own node operator. This makes composition transitive without propagating
the root caller's wallet authority across hops.

For direct invocation, private Context Graph membership intentionally grants the right to request
Program execution; there is no mandatory caller-to-Program ACL. Final execution
authority remains with the target operator: every tool requested by the
Wasm-admitted Program must be offered by that operator, allowed by its
operator-authored VM policy, and backed by a locally installed and enabled
adapter. See
[`docs/architecture/semantic-runtime-invocation-authorization.md`](../../docs/architecture/semantic-runtime-invocation-authorization.md)
for the decision, trust model, and optional finer-grained policy extensions.

Admission can be exercised without activating the daemon integration:

```ts
const admission = new WasmStrategyAdmissionClient();
const result = await admission.compileAndAdmit(source);
if (!result.ok) console.error(result.diagnostics);
```

The conformance suite covers all restart classes and sibling strategies,
restart intensity, bounded mailboxes and budgets, native/Wasm kernel parity,
Worker hang/trap recovery, durable replay, every protected-effect crash
boundary, trusted activation, redacted projection, and the Listener Boy
ambiguous-effect lifecycle.

### Optional operator Program policy

`semanticRuntime.programPolicy` adds local execution and disclosure controls independently
of any marketplace. Install it in trusted node configuration, alongside the existing
`operatorPolicyIri`; invocation requests and RDF Programs cannot grant themselves this policy.
Without this option, the existing adapter selection behavior remains available.

```json
{
  "programPolicy": {
    "contextGraphIds": ["tenant-equipment"],
    "programs": [
      {
        "programIri": "urn:program:maintenance-assessment",
        "sourceHash": "<SHA-256 of the exact reviewed S-expression source>"
      },
      {
        "programIri": "urn:program:maintenance-count",
        "sourceHash": "<SHA-256 of the exact reviewed S-expression source>",
        "queries": ["<reviewed SemanticQueryPin object>"]
      }
    ],
    "disclosure": {
      "policyId": "urn:policy:maintenance-summary",
      "promptSha256s": ["<SHA-256 of the exact allowed prompt>"],
      "programs": [{
        "programIri": "urn:program:maintenance-count",
        "sourceHash": "<same reviewed child source hash>",
        "outputIndexes": [0],
        "allowedJsonPointers": ["/result/bindings/0/count"]
      }]
    }
  }
}
```

This is a configuration template: replace the placeholders with reviewed pins and
64-character lowercase hexadecimal hashes. The CLI helper `createSemanticQueryPin`
constructs a pin from a decoded catalog item and a closed, bounded output schema.
Review the query, its parameters, graph/view selection, and output schema before
installing that pin. The adapter checks the catalog definition before querying and
the actual query result against the schema before returning it. Omitting `queries`
from a Program in pinned mode grants no named queries.

Pinned mode registers only `dkg/query` and, when a disclosure policy is present,
`llm/safe`. Investigator and remote-execute adapters are unavailable in this mode.
Permitted children must be pinned and hosted locally; child invocations retain the
original caller. Local composition rejects cycles and chains longer than eight
Programs. Each LLM run retains the existing four-tool-call limit. The host rechecks
caller graph access, Program declarations/source, operator policy and active runtime
capabilities before model dispatch, child invocation and disclosure. Parent authority
also applies to nested children. This does not cancel a provider request already sent.

Disclosure rules select ordered child output positions, optionally projecting only
named JSON scalar fields. Omitting `allowedJsonPointers` releases the entire selected
output string. JSON objects/arrays cannot be released through a scalar pointer after
a schema change. Only a pinned prompt and approved opaque tool descriptions are sent;
raw child errors and child execution identifiers are excluded from model tool results.
Returned model text remains untrusted. These controls are additional host policy;
Wasm isolation alone does not authorize data release.

Execution KAs now include `sr:orderedOutputs`, a JSON string array preserving positions
and duplicate values alongside the existing `sr:output` triples. Reads check that both
representations agree. Legacy records with multiple distinct outputs fail closed because
RDF triples cannot recover their order; zero/single-value legacy records remain readable.
Invocation reuse is bound to the caller, source, policy, graph and memory layers. Older
journal entries without these bindings require a new invocation UUID.

### Checkpointed adapter continuation

The runtime journal migrates existing v1 databases to v2 by adding a bounded adapter
checkpoint table. `writeAdapterCheckpoint` binds payloads to an existing effect digest
and uses an expected version to reject concurrent writes. Checkpoints remain local to
the node and may contain sensitive adapter state; no payload inspection HTTP route is
introduced here.

Adapters may explicitly implement `resume` and use `RuntimeEffectBroker.resumeUnknown`
when they can continue from durable receipts without repeating an unresolved side effect.
Continuation rechecks current capability, policy, expiry and adapter enablement, including
after asynchronous checks. Continuation and reconciliation serialize per database/effect
within one daemon process; this is not a lease for multiple processes sharing a database.
Terminal reconciliation updates are transactional.

The direct Rig LLM adapter does not implement `resume`: an interrupted model request
still requires reconciliation/manual review and is never blindly replayed. Provider
idempotency/status protocols, paid-call receipts, billing and seller transport belong to
the adapter/application that supplies those guarantees.

Tenant-configured invoke-only operations can load a pinned Program from a separate Context Graph while keeping the data graph private. See [tenant Program bindings](../../docs/architecture/tenant-program-bindings.md) for setup, API calls, activation and revocation. These query-only operations derive execution authority from the trusted local binding and installed query adapter, without requiring VM policy or tool-offer publication. Direct invocation retains its VM policy requirements.
