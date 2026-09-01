# DKG semantic runtime

This package contains the default-off TypeScript host and Rust/Wasm foundation
for the DKG V10 supervised semantic runtime. It verifies the packaged Wasm and
generated glue before starting a Node Worker, enforces watchdog deadlines,
replaces failed Workers, and restores a verified snapshot.

The packaged Wasm also owns bounded S-expression parsing, deterministic plan
compilation, and canonical-plan re-admission. Compilation uses a disposable
Worker; a fresh Worker re-decodes the immutable plan, resolves its pinned
adapter registry, recomputes effects, capabilities, approval paths, conflicts,
and resource bounds, and rejects metadata-only or hash-only admission.

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

When enabled, a missing or modified artifact, incompatible ABI, failed Worker
handshake, or restore mismatch fails closed.

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
