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
`POST /api/semantic-runtime/invoke` route loads a program by IRI from the
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

Private Context Graph membership intentionally grants the right to request
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
