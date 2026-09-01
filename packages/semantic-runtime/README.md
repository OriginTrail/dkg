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
clock authority. Its sole repository-owned import is an opaque, host-created
execution capability.

Programs are stored in the DKG as `sr:Program` resources with `sr:language`,
`sr:version`, and `sr:source` triples. The authenticated
`POST /api/semantic-runtime/invoke` route loads a program by IRI from the
explicitly selected WM, SWM, or VM view of the requested context graph, admits
its S-expression in Wasm, and executes its logical agents there. The caller
also explicitly selects the Execution KA's target layer. The first narrow execution slice
supports ordered `emit` forms and one exact `agent/investigate@1` model request
per delegate. The TypeScript host performs only that requested external call
and returns its result to the waiting Wasm process.

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
