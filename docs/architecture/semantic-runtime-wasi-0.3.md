# Semantic runtime WASI 0.3 component boundary

## Scope

The Program remains an S-expression stored as RDF in a DKG Knowledge Asset.
One shared Rust kernel parses, admits, and advances all Programs. TypeScript
resolves DKG entities, owns authority and durable effects, and publishes the
terminal `sr:Execution` KA; it does not interpret the language.

The official Rust WASI 0.3 component build uses a `wasm32-wasip2` carrier with
async WIT bindings. This is the documented Rust flow for WASI 0.3 components,
not a fallback to the WASI 0.2 runtime contract. The toolchain is pinned in
`rust/rust-toolchain.toml`, and the component ABI is
`origintrail:semantic-runtime@0.1.0`.

References:

- [WASI 0.3.0 release](https://github.com/WebAssembly/WASI/releases/tag/v0.3.0)
- [Rust components with WASI 0.3](https://component-model.bytecodealliance.org/language-support/creating-runnable-components/rust.html)

## Boundary

`rust/crates/dkg-runtime-component/wit/semantic-runtime.wit` exports typed
`compile`, `admit`, and `start` functions plus an opaque `execution` resource.
The resource exposes typed `advance` and `inspect` methods. `advance` is an
asynchronous component export and returns terminal output or a diagnostic.

The component wrapper calls the existing `dkg-runtime-wasm` kernel directly,
so there is still one parser and execution implementation. The kernel's
internal effect state is never exported through WIT. The component can invoke
only the explicit `investigator` and `query-catalog` imports compiled into its
world; there is no generic operation-name import or exported effect dispatcher.

Each explicit import is implemented by the host as a durable broker call. The
host journals and authorizes the request before dispatch and returns the
recorded result to the suspended component. A suspended JS/Wasm stack is not
the durable source of truth: replay derives the same typed call and effect ID,
then the broker returns or reconciles its journaled outcome.

## Authority

The repository-owned component imports are the host-defined
`execution-capability` resource and the explicit `investigator` and
`query-catalog` tool interfaces. The host creates the capability from the exact
admitted invocation and freezes a descriptor containing:

- execution and invocation IDs, Context Graph, caller, Program IRI, source
  hash, plan hash, and output layer;
- exact admitted tool operation, semantic version, and WIT interface;
- operator policy identity, epoch, and hash; and
- operation/tool/model/query budgets, expiry, revocation, and approvals.

The component cannot construct or alter this resource. A plan-hash mismatch,
expired or revoked capability, exhausted budget, unknown import, disabled tool,
or WIT mismatch fails closed. Program declarations request authority but never
grant it.

The Rust carrier currently declares a small set of preview-2 imports inserted
by the Rust standard library. The Node linker supplies deny-only proxies for
all of them. No filesystem, HTTP/network, sockets, process, environment,
stdio, wall clock, or random capability is inherited or preopened.

Effects still cross `RuntimeEffectBroker`. The broker rechecks the admitted
operation and version, DKG Tool descriptor and WIT interface, selected policy,
local adapter, capability binding, input digest, policy epoch, approvals,
budget, expiry/revocation, and idempotency identity before dispatch.

## Concurrency and limits

Admission gets a disposable component Worker. Each active Program execution
gets a separate Worker, component instance, opaque capability, and resource
handle. There is no global execution-operation queue.

```text
bounded ComponentExecutionPool
  execution A -> Worker A -> component/store/resource A -> ordered operations A
  execution B -> Worker B -> component/store/resource B -> ordered operations B
```

Independent executions can wait on LLM or DKG Query effects concurrently.
Operations within one execution remain ordered. The default active-execution
limit is 8 and overload is explicit. Each partition has:

- a 256 MiB old-generation Worker limit plus bounded young generation/stack;
- a component core memory range of 256 to 4096 pages;
- a deterministic maximum-operation budget; and
- a watchdog that hard-terminates the Worker on timeout.

A trap, timeout, or memory/resource failure destroys only the affected
partition. No component instance or resource handle is shared between active
executions.

## Durability and restart recovery

The durable protocol remains authoritative:

1. derive the deterministic effect ID and idempotency key;
2. authorize and persist `prepared` before external dispatch;
3. persist the outcome;
4. resume a component with that recorded outcome; and
5. publish the final `sr:Execution` KA to the caller-selected WM, SWM, or VM
   layer before returning persisted success.

On retry after a host/component failure, the Program is re-admitted and replayed
to the same effect ID. A recorded success is supplied to a fresh component and
the external operation is not repeated. A crash in ambiguous `dispatching`
state becomes `unknown`; non-repeatable operations require adapter
reconciliation or manual review rather than blind retry. This preserves the
existing DKG effect journal and Execution-KA behavior.

## Artifact identity

`scripts/build-semantic-runtime.mjs` validates the pinned compiler and jco,
component/WIT ABI, exact import/export set, all generated bindings and embedded
core modules, and memory limits. `generated/integrity.json` hashes every local
artifact. The checked-in `artifact-lock.json` pins the integrity manifest,
component, and WIT hashes. Daemon startup verifies both layers and never
rebuilds artifacts.

## Known host limit

Jco's Node/JSPI host does not expose Wasmtime instruction fuel or epoch
interruption. This implementation therefore enforces semantic operation fuel,
Worker memory bounds, and a hard Worker-termination watchdog, but cannot meter
individual Wasm instructions. If instruction-level metering becomes mandatory,
the smallest follow-up is a Rust Wasmtime component host that retains this WIT
ABI and connects to the existing broker through a narrow authenticated IPC
boundary.
