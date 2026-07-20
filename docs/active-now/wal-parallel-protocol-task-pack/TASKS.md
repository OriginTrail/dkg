# OT-RFC-65 parallel-protocol implementation tasks

## System context for every task

Every task in this document inherits the complete contents of
[OT-RFC-65-wal-byte-set-reconciliation-sync.md](OT-RFC-65-wal-byte-set-reconciliation-sync.md)
as its mandatory system context. The RFC
must be supplied in full when dispatching any individual task. The focused RFC
sections named below are navigation aids; they do not exclude the remainder of
the RFC.

The common implementation rule is: build the entire WAL protocol beside the
current graph-sync stack, keep the current stack authoritative, and write only
to isolated WAL/shadow projection state until the signed hard-cutover tasks are
separately accepted.

The architecture has **two synchronization mechanisms and one semantic
system**. `legacy` names only the current synchronization mechanism. Both
current sync and WAL replay MUST invoke the same existing DKG semantic
implementation, SWM/VM model, verified-memory logic, chain/finality/reorg
validation, membership authority, and cryptographic implementation. WAL
reconciliation handles authenticated protocol bytes, `WalObjectId` sets, and
complete `WalObjectV1` byte ranges only. The WAL replay/conflict adapter may
schedule causal work and retain incompatible branches but MUST delegate every
DKG-specific decision to the shared semantic core. Projection persistence MUST
only atomically store the resulting outcome.

## Task index

| ID | Task | Depends on | Primary result |
|---|---|---|---|
| `WAL-000` | Freeze the shared semantic oracle and current-sync performance baseline | — | Reproducible DKG semantic truth plus current-sync measurements. |
| `WAL-001` | Close RFC implementation-freeze decisions and vectors | `WAL-000` | One atomic `WalObjectV1`, byte-interoperable range framing, schemas, and fixtures. |
| `WAL-002` | Scaffold WAL package, runtime modes, and isolation | `WAL-000`, `WAL-001` | Safe `legacy`/`parallel`/`wal` skeleton with legacy default. |
| `WAL-003` | Implement canonical encoding, signatures, and object IDs | `WAL-001`, `WAL-002` | Canonical protocol objects and golden vectors. |
| `WAL-004` | Implement durable WalObjectStore and resumable whole-object ranges | `WAL-003` | Bounded-memory staging and atomic promotion of complete WAL objects. |
| `WAL-005` | Implement rateless IBLT reconciliation with full unit coverage | `WAL-003` | Exact symmetric-difference discovery, signed-root verification, and bounded fallback. |
| `WAL-006` | Implement crash-safe WalStore and SQLite control state | `WAL-003`–`WAL-005` | Durable objects, lanes, checkpoints, staging, and replay queues. |
| `WAL-007` | Implement membership, author checkpoints, vectors, and authority lifecycle | `WAL-003`, `WAL-005`, `WAL-006` | Exact completeness and freshness authority. |
| `WAL-008` | Integrate private inline payload envelopes and Sender Key epochs | `WAL-003`, `WAL-004`, `WAL-007` | Fail-closed private bytes without changing DKG membership semantics. |
| `WAL-009` | Implement bounded authenticated WAL wire protocols | `WAL-002`–`WAL-008` | Three versioned protocol families with the complete frozen method catalog. |
| `WAL-010` | Implement provider discovery, selection, failover, and cold start | `WAL-004`, `WAL-005`, `WAL-007`, `WAL-009` | Correct multi-provider retrieval and authorized bootstrap. |
| `WAL-011` | Implement remote admission, causal closure, and quarantine | `WAL-006`–`WAL-010` | One fail-closed admission path for fetched WAL objects. |
| `WAL-012` | Implement RDF canonicalization, mutation encoding, and signed replay policy | `WAL-001`, `WAL-003` | Deterministic encoding of shared-core outcomes without remote SPARQL execution. |
| `WAL-013` | Implement local WAL commit and publisher shadow integration | `WAL-006`–`WAL-008`, `WAL-012` | Idempotent WAL-first local objects beside production writes while legacy sync remains authoritative. |
| `WAL-014` | Implement deterministic replay/conflict adapter over the existing semantic core | `WAL-011`, `WAL-012`, `WAL-013` | Arrival-order-independent scheduling and conflicts with no second DKG implementation. |
| `WAL-015` | Persist shared-core results atomically and support rebuild | `WAL-006`, `WAL-014` | Persist shared-core outcomes and exact markers without semantic decisions. |
| `WAL-016` | Feed VM/finality/reorg events into the existing semantic core | `WAL-007`, `WAL-008`, `WAL-011`, `WAL-014`, `WAL-015` | Existing VM semantics driven by WAL events without a second VM model. |
| `WAL-017` | Implement deletion, expiry, snapshots, custody, and compaction | `WAL-004`–`WAL-007`, `WAL-011`, `WAL-014`, `WAL-015` | Bounded history with no resurrection. |
| `WAL-018` | Implement genesis migration, backfill, and rebuild tooling | `WAL-016`, `WAL-017` | Authenticated bootstrap from existing SWM/VM state. |
| `WAL-019` | Implement reconciliation driver and complete network shadow protocol | `WAL-009`–`WAL-018` | Pull-correct shadow convergence with persistent retries. |
| `WAL-020` | Implement operator APIs, readiness, metrics, and admin controls | `WAL-002`, `WAL-007`, `WAL-019` | Exact operational truth for every collection/view/lane. |
| `WAL-021` | Build fault-injection, adversarial, and security acceptance suite | `WAL-003`–`WAL-020` | Automated proof of crash and security invariants. |
| `WAL-022` | Build measurable-goal benchmark and evidence pipeline | `WAL-000`, `WAL-019`–`WAL-021` | Reproducible semantic, scale, resource, and parity evidence. |
| `WAL-023` | Implement signed network cutover and fail-closed authority switch | `WAL-001`, `WAL-018`–`WAL-022` | One persistent `CutoverId`; no mixed authority. |
| `WAL-024` | Run full-fleet shadow soak, cutover rehearsal, and legacy retirement | `WAL-000`–`WAL-023` | Evidence-backed release decision and deletion of superseded paths. |

---

## WAL-000 — Freeze the shared semantic oracle and current-sync performance baseline

**Focused RFC context:** Abstract; Sections 1, 18, 21, and measurable success
criteria.

### Objective

Capture the existing DKG/SWM/VM/verified-memory/cryptographic behavior as the
single semantic oracle before adding WAL code, and measure the current
synchronization mechanism separately. Current-sync failures are observations,
not the semantic correctness baseline. This task proves that the new
replication boundary invokes rather than rewrites the shared semantic core.

### Scope and deliverables

- Inventory every publish, share, update, delete, expiry, membership change,
  private-access decision, VM promotion, finality, and reorg path.
- Create a reusable golden corpus directly against the existing semantic core
  that records canonical RDF, active graph
  digests, lifecycle/API state, authorization decisions, crypto validation
  outcomes, and chain evidence.
- Add current-sync measurement scenarios for equal peers, reconnect delta, late join, current
  full sync, interrupted sync, and store/process restart.
- Define an evidence manifest containing commit, configuration, hardware,
  dataset, roster, chain snapshot, commands, raw digests, latency, bytes, CPU,
  RSS, request counts, and triplestore operations.
- Reuse existing publisher, agent, storage, chain, and devnet fixtures rather
  than creating a second semantic model inside the benchmark.

**Likely surfaces:** `packages/publisher/test/`, `packages/agent/test/`,
`packages/chain/test/`, `packages/storage/test/`, `devnet/v10-core-flows/`,
`devnet/v10-end-to-end/`, `devnet/v10-stress/`, and `bench/`.

### Acceptance area

- [ ] The corpus covers every existing supported SWM and VM mutation/lifecycle
      type and every current crypto/authorization decision named by the RFC.
- [ ] Each fixture exercises the existing semantic implementation and produces
      stable canonical RDF, state, conflict/lifecycle,
      authorization, and VM digests suitable for old/new comparison.
- [ ] Equal, delta, late-join, private, VM-reorg, and crash measurements run from one
      documented command family on a clean `origin/main` build.
- [ ] Evidence explicitly distinguishes shared semantic truth from known
      current-sync failures; current sync is never treated as the correctness
      oracle merely because it is production-authoritative.
- [ ] Performance profiles run at least three times and report median, p95, p99,
      bytes, requests, CPU seconds, peak RSS, and triplestore operations.
- [ ] Raw receipts identify the exact main commit and are stored outside the
      source tree or as intentional small fixtures, with no generated pollution.
- [ ] A reviewer can rerun one semantic and one performance profile and obtain
      the documented digest schema and comparable measurements.

---

## WAL-001 — Apply the protocol-v1 freeze and publish conformance vectors

**Focused RFC context:** Sections 4–9, 12–17, 22–24.

### Objective

Apply every resolution in RFC v0.8 Section 22 before production implementations
encode incompatible assumptions. The result must be an executable normative
wire/convergence contract, not additional prose ambiguity. The conformance
harness is TypeScript-only; this task does not add Go or another implementation
language.

### Scope and deliverables

- Freeze `WalObjectV1` as the sole durable content-addressed synchronization
  atom. Its canonical version-1 representation is an exact-arity deterministic
  CBOR tuple with the following logical fields:

  ```text
  WalObjectV1 = [
      version,
      namespaceId,
      writerId,
      writerEpoch,
      sequence,
      previousObjectIdOrNull,
      payloadBytes,
      signature
  ]
  ```

  `payloadBytes` is inline and opaque to the generic WAL protocol. It MUST NOT
  have a separate `PayloadId` or `BlobId`; payload fragments and transfer chunks
  MUST NOT have independent content identities, signatures, set membership, or
  durable protocol representations. Set reconciliation operates exclusively on
  `WalObjectId` values.
- Freeze exact-arity tuple schemas for every remaining control-plane request,
  response, checkpoint, snapshot declaration, legacy-genesis declaration,
  policy, receipt, and cutover message. DKG/SWM/VM fields belong inside the
  adapter-owned opaque payload and MUST NOT leak into `WalObjectV1`.
- Define domain-separated signing and identity rules over the canonical complete
  object. The object becomes locally visible only after all canonical bytes have
  arrived and the complete `WalObjectId`, signature, tuple arity, and canonical
  encoding have been validated.
- Define resumable range transport as ephemeral framing rather than WAL object
  structure. At minimum, freeze byte-exact schemas equivalent to:

  ```text
  GetWalObjectRangeV1 = [walObjectId, offset, maximumLength]
  WalObjectRangeV1    = [walObjectId, totalObjectLength, offset, bytes]
  ```

  The offset addresses the canonical encoding of the complete `WalObjectV1`,
  not `payloadBytes` independently. Range frames may be retried, reordered, and
  sourced from different authorized providers, but are never reconciliation
  atoms and are not accepted as independently complete content.
- Define the large-object contract: stream ranges into quota-controlled
  temporary storage; keep memory bounded independently of object size; persist
  only local resumable progress; defend against dishonest lengths and sparse-file
  exhaustion; recompute the complete object hash; verify the signature; fsync;
  and atomically promote the object. Size is governed by explicit local/network
  admission policy rather than by creating smaller content-addressed chunks.
- Record the intentional trade-off: protocol v1 provides no sub-object
  deduplication or independent cryptographic verification of ranges. Adding a
  Merkle/chunk identity layer would change the synchronization-atom invariant
  and therefore requires a later protocol version and RFC decision.
- Audit every RFC and backlog requirement to ensure no payload, blob, range, or
  chunk is treated as a separately content-addressed synchronized object before
  dependent implementation tasks begin.
- Define the adapter-owned payload-envelope form, including any length, codec,
  media type, encryption algorithm, key epoch, nonce, and associated-data
  fields required by DKG semantics. The envelope is encoded entirely inside
  `payloadBytes`, is covered by the enclosing WAL-object signature/identity, and
  has no independent generic-WAL identity or fetch protocol.
- Fix snapshot parents/base heads, post-compaction causal closure, custodian
  receipts, retention, and removed-custodian behavior.
- Fix empty roots, nibble packing, proof framing, pagination, malformed-proof
  rejection, replay/conflict relations, common-base rules, resource limits, provider
  cold start, authority rotation/HA, rollback-guard recovery, cutover cohort,
  late-node behavior, private-safe `MOVE_TIER`, and VM finality policy.
- Freeze the measured binary64 IBLT mapping exactly: unsigned-u64 conversion,
  round-to-nearest-ties-to-even after every named binary64 operation, correctly
  rounded square root, fixed evaluation order, and prohibition of extended
  intermediates, reassociation, or fused evaluation. No float is serialized;
  the result is a deterministic integer symbol index.
- Publish byte fixtures for CBOR tuples, signatures, IDs, set commitments,
  rateless IBLT symbols/peeling, object ranges, encryption, snapshots, replay/conflict
  cases, and cutover objects in the spec and code repos.
- Mirror the exact normative schema/vector files from the spec task-pack context;
  generated copies must compare byte-for-byte so dependent tasks cannot consume
  a locally reinterpreted protocol.

### Acceptance area

- [ ] The normative RFC states that `WalObjectV1` is the smallest and only
      durable content-addressed set-reconciliation atom; a repository-wide
      specification/backlog audit finds no separately synchronized `PayloadId`,
      `BlobId`, content-addressed chunk, or payload-fragment identity.
- [ ] Golden vectors freeze the exact tuple arity, field positions, null rules,
      domain separators, signature input, complete canonical bytes, and
      `WalObjectId`; missing, extra, reordered, or non-canonical fields fail.
- [ ] The generic tuple contains no graph, RDF, SPARQL, SWM/VM, policy, tier,
      chain, or conflict field; such information occurs only in opaque
      adapter-owned `payloadBytes`.
- [ ] Set-reconciliation tests exchange only `WalObjectId` values and fetching
      one missing ID reconstructs exactly one complete `WalObjectV1`.
- [ ] Range-frame vectors cover zero-length, first, middle, final, duplicate,
      overlapping, out-of-order, cross-provider, interrupted, resumed,
      dishonest-total-length, overflow, and out-of-bounds cases without giving
      any range an independent durable or content-addressed identity.
- [ ] A large-object integration test streams an object substantially larger
      than the process memory budget into temporary storage, keeps measured
      memory within the frozen bound, resumes after restart, and publishes no
      partial object before complete hash/signature/canonicality verification
      and atomic promotion.
- [ ] Quota, concurrency, advertised-length, sparse-file, timeout, cancellation,
      and cleanup tests prove that malicious or abandoned large transfers cannot
      exhaust memory or durable staging space.
- [ ] Documentation explicitly states that changing one payload byte produces a
      new whole-object identity and that v1 does not promise cross-object range
      deduplication or pre-completion content verification.
- [ ] All ten former RFC implementation-freeze items have the explicit normative
      v0.8 answer merged or approved in `dkgv10-spec`; none remains implicit in code.
- [ ] At least two independently written TypeScript test implementations consume the same fixtures
      and produce byte-identical encodings, IDs, roots, proofs, and replay/conflict
      digests; no new implementation language is introduced for conformance.
- [ ] Binary64 boundary vectors cover u64-to-binary64 rounding, the `+1.0`
      boundary, square-root/division/product rounding, `ceil`, minimum distance,
      and safe-index overflow. Both TypeScript consumers reproduce every index.
- [ ] Valid and invalid vectors cover empty, boundary, duplicate, reordered,
      truncated, oversized, cross-view, stale-authority, and downgrade cases.
- [ ] The finality rule proves that an author-supplied value cannot weaken
      network/chain policy.
- [ ] The tier-movement schema proves that a public VM response discloses no
      private SWM identifier, graph name, epoch, count, or causal shape.
- [ ] The task-pack RFC, schema, and vector system-context files, source commit,
      and checksum are refreshed after the normative RFC change before dependent
      tasks proceed.

---

## WAL-002 — Scaffold the WAL package, runtime modes, and state isolation

**Focused RFC context:** Sections 0–3, 18–20, and 23.

### Objective

Create the package and runtime skeleton that lets the complete WAL protocol run
beside legacy sync without changing production synchronization authority or the
shared semantic implementation.

### Scope and deliverables

- Add `packages/wal` as `@origintrail-official/dkg-wal` with build, test, lint,
  exports, and dependency boundaries.
- Add explicit `sync.mode = legacy | parallel | wal` configuration through CLI,
  resolved agent config, startup, status, and documentation.
- Default existing and new installations to `legacy` until a later approved
  release changes policy; `parallel` must require explicit enablement.
- Allocate separate durable WAL-object, range-staging, quarantine, and shadow-RDF
  locations under `DKG_HOME`; never reuse legacy progress files or graphs.
- Define lifecycle interfaces for start, stop, drain, replay, readiness, and
  fatal configuration mismatch without implementing protocol semantics yet.

**Likely surfaces:** `packages/wal/`, `pnpm-workspace.yaml`, root build scripts,
`packages/cli/src/config.ts`, daemon lifecycle/routes, `packages/agent/src/`, and
package export maps.

### Acceptance area

- [x] A clean install builds and tests the new workspace package.
- [x] Omitted mode preserves byte-for-byte current startup behavior and registers
      no WAL protocol or worker.
- [x] `parallel` creates isolated state, starts shadow components, and leaves all
      production reads/writes and legacy sync authoritative.
- [x] `wal` refuses to start without the future signed cutover prerequisites;
      configuration alone cannot bypass that gate.
- [x] Start/stop/restart tests prove no leaked workers, open handles, ports, or
      shared state between legacy and shadow paths.
- [x] Config validation rejects unknown modes, unsafe path overlap, and
      incompatible adapter/protocol versions with stable reason codes.

**Implementation evidence:** `WAL-002-EVIDENCE.md` records the exact authority
boundary, isolated layout, CLI/API behavior, acceptance mapping, and validation
receipts. Protocol registration, mutation capture, object storage, transfer,
reconciliation workers, and WAL-015 storage integration remain owned by their
later tasks.

---

## WAL-003 — Implement canonical encoding, signatures, and object identities

**Focused RFC context:** Sections 4, 6, and 23.

### Objective

Implement the exact deterministic byte representation and identity layer on
which every later proof and replication decision depends.

### Scope and deliverables

- Implement the RFC 8949 deterministic-CBOR exact-arity tuple profile,
  canonical rejection, NFC strings, fixed widths, sorted/deduplicated sets,
  explicit null positions, and no maps/floats/tags/indefinite forms.
- Implement the exact eight-position `WalObjectV1` codec with inline opaque
  `payloadBytes`; no alternate JSON/map encoding and no separately typed
  payload/blob/chunk identity.
- Implement domain-separated BLAKE3 digests and IDs for complete signed WAL
  objects, membership, author checkpoints, vectors, and cutover manifests.
- Implement current secp256k1/EIP-191 signing and recovery with canonical low-S
  signatures and normalized recovery bits.
- Implement typed codecs for all protocol objects frozen by `WAL-001`; do not
  introduce JSON as an alternate signed representation.
- Consume the language-neutral golden fixtures from the two independently
  written TypeScript conformance implementations and add property tests for
  canonicality; do not introduce a new implementation language.

### Acceptance area

- [x] Every valid conformance fixture encodes to the exact expected bytes, digest,
      signer, and object ID.
- [x] Every alternate/non-canonical encoding is rejected rather than normalized
      after receipt.
- [x] Tuple arity/position, missing/extra value, explicit-null, map rejection,
      Unicode normalization, integer boundaries, set ordering, low-S,
      recovery-bit, and domain-confusion negatives pass.
- [x] Round-trip/property tests do not create two byte representations for one
      accepted logical object.
- [x] Existing author/curator key adapters sign and verify without redefining
      their DKG authority.
- [x] Package build, lint, unit tests, and fixture checksum verification pass.

**Implementation evidence:** `WAL-003-EVIDENCE.md` records the production
codec/identity boundary, frozen-vector mapping, signer/authority integration,
negative/property coverage, and exact validation receipts.

---

## WAL-004 — Implement the durable WalObjectStore and resumable whole-object ranges

**Focused RFC context:** Sections 7, 9, 10, 15, 17, and measurable transfer goals.

### Objective

Store and reconstruct complete canonical `WalObjectV1` atoms independently of
RDF and providers, with bounded memory, resumable ephemeral byte ranges, final
whole-object verification, and crash durability.

### Scope and deliverables

- Freeze the public storage boundary to this complete-object-only shape:

  ```ts
  abstract class WalObjectStore {
    abstract has(id: WalObjectId): Promise<boolean>;
    abstract read(id: WalObjectId, offset?: bigint, length?: number): AsyncIterable<Uint8Array>;
    abstract put(expectedId: WalObjectId, bytes: AsyncIterable<Uint8Array>): Promise<void>;
    abstract ids(): AsyncIterable<WalObjectId>;
  }
  ```

  `put` verifies and atomically admits one complete object; `read` offsets
  address its full canonical bytes; and `ids` is strict unsigned lexical order.
  Range progress, provider identity, temporary paths, deletion, quarantine,
  RDF, and SPARQL do not appear in this abstract contract.
- Implement scalable local packed segments keyed through a SQLite B-tree from
  `WalObjectId` to local segment/offset/length. Segment IDs, record headers,
  offsets, index rows, and pages are never synchronization atoms or wire data.
  Admission must verify complete canonical bytes before append, fsync segment
  bytes before index commit, truncate unindexed crash tails on restart, rotate
  bounded segments, and retain the simple file-per-object backend only as a
  reference implementation.
- Freeze the local packed format as a 32-byte `DKGWSEG1` header (schema `u32`,
  reserved bytes, segment ID `u64`, reserved bytes), followed by 48-byte
  `DKGWREC1` record headers (`WalObjectId[32]`, canonical length `u64`) and the
  unchanged canonical object bytes. Integers are unsigned big-endian. Keep the
  mutable object/offset catalog in SQLite rather than rewriting a shared
  segment header on every append.
- Implement quota-controlled temporary files, local range-progress metadata,
  overlap/reorder handling, restart resume, final ID/signature/canonicality
  verification, fsync/atomic commit, and orphan cleanup.
- Stream ranges directly to temporary storage; memory usage must remain bounded
  independently of total WAL-object size.
- Enforce negotiated total length, offset arithmetic, maximum range, staged
  bytes, sparse-file growth, concurrency, staging lifetime, disk quota, and
  path-safety limits before allocation or expensive parsing.
- Support ranges from multiple authorized providers without treating provider
  session state, a range, inline payload, or progress bitmap as proof of object
  correctness.
- Keep range hashes/IDs out of persistent protocol schemas. Protocol v1 accepts
  only the complete `WalObjectId` after all canonical bytes are reconstructed.
- Implement range reconstruction as a package-internal concrete service rather
  than a public storage abstraction. Its JSON metadata is local restart state,
  never a signed, hashed, reconciled, or wire representation.

### Acceptance area

- [x] Zero-payload, one-range, multi-range, maximum-policy-size, out-of-order,
      overlapping, duplicate, interrupted, restarted, and multi-provider cases
      reconstruct the exact canonical WAL-object bytes and ID.
- [x] Dishonest total length, overflow, gap, truncation, out-of-bounds offset,
      conflicting overlap, invalid tuple, non-canonical CBOR, wrong signature,
      wrong ID, path traversal, sparse-file exhaustion, and oversized cases fail
      before an object becomes complete or visible.
- [x] Crashes after range write, progress update, fsync, rename, parent fsync, and
      metadata commit recover to a safe resumable state with no false completion.
- [x] Durably recorded complete ranges are not retransmitted and an interrupted
      stream retransmits at most one in-flight range.
- [x] A WAL object substantially larger than the configured process-memory
      budget transfers and verifies while measured memory remains within the
      frozen bound and small-object streams continue making progress.
- [x] Repository and wire-schema assertions prove there is no `PayloadId`,
      `BlobId`, content-addressed range/chunk, or independent payload fetch path.
- [x] Concurrent providers cannot substitute bytes or cause two objects to
      occupy the same final path.
- [x] Packed-store restart tests prove an index row never points beyond durable
      segment bytes; unindexed tails are truncated; missing/corrupt segment,
      record-header, index, schema, and path state fails closed; and concurrent
      duplicate admission creates one index row and one physical record.
- [x] A fresh-process packed-store benchmark covers `N = 10^4`, `10^5`,
      `10^6`, and `10^7`; separates synthetic index-cardinality preparation
      from genuine verified admission; and reports ordered `ids`, hit/miss
      `has`, verified full/ranged reads, verified/idempotent `put`, 8 MiB
      throughput, CPU, RSS, and p50/p95/p99 latency.

---

## WAL-005 — Implement rateless IBLT reconciliation with full unit-test coverage

**Focused RFC context:** Sections 6.8, 8, 9, 17, 21–23, and measurable
reconciliation goals.

### Objective

Implement the complete, application-agnostic reconciliation algorithm over
32-byte `WalObjectId` sets. This task owns only deterministic set commitment,
rateless IBLT symbol generation/subtraction/peeling, decode verification, and
bounded sorted-ID fallback. It does not own discovery, network framing, object
transfer, authorization, admission, RDF, or SPARQL.

### Scope and deliverables

- Implement the deterministic 16-way radix Merkle set commitment, including the
  frozen empty root, insertion-order independence, incremental updates, and a
  simple reference root implementation. The tree is an authenticated
  commitment, not the normal wire reconciliation algorithm.
- Implement the `ProtocolV1IbltReconciliationAlgorithm` exactly: seed
  derivation, the RFC v0.8 binary64 symbol-membership evaluation order, degree
  distribution, signed-i64 count arithmetic, 32-byte ID XOR, domain-separated
  checksum XOR, deterministic symbol order, and canonical symbol tuples. This
  name denotes an algorithm, not a protocol object. The exact-integer mapping
  remains experiment evidence and MUST NOT be negotiated or emitted as
  protocol-v1 membership.
- Implement pure encode, subtract, incremental-window append, pure-symbol
  detection, deterministic peeling, and provider-only/receiver-only output.
- Require successful decoding to leave a zero residual, pass every checksum,
  produce unique bounded IDs, and reconstruct the provider's signed object
  count and set root from the receiver set plus the decoded difference.
- Implement detectable decode failure for residual cores, insufficient symbols,
  overflow, malformed cells, duplicate output, checksum mismatch, count/root
  mismatch, and configured CPU/memory/symbol/elapsed limits. Failure returns no
  accepted partial difference.
- Implement deterministic sorted/paginated full-ID fallback bound to a signed
  head. Acceptance requires exact count and recomputed root; empty-node backfill
  may select this path immediately.
- Publish language-neutral golden vectors for the set root, seed, every symbol
  window, subtraction state, peel trace, decoded directions, reconstructed root,
  failure cases, and fallback pages; consume them with two independently written
  TypeScript implementations without adding a production language.
- Keep the module dependency-free from DKG semantics and expose pure interfaces
  that `WAL-009` and `WAL-019` can drive.
- Enforce the atom boundary in code and schemas: the algorithm, parameters,
  symbols, local set-commitment nodes, range frames, and local progress records
  may be disposable caches or control data but MUST NOT receive content IDs,
  enter the reconciled content set, be admitted to `WalObjectStore`, or acquire
  an independent synchronization lifecycle. Only `WalObjectId` is a reconciled
  set element and only complete canonical `WalObjectV1` is synchronized content.

### Acceptance area

- [ ] The dedicated reconciliation package reports 100% line, statement,
      function, and branch coverage. Generated fixture data is the only allowed
      coverage exclusion; reconciliation source files may not use ignore
      directives.
- [ ] Unit tests cover empty/equal sets; one-sided and two-sided differences;
      one ID; duplicate input rejection; disjoint sets; high-overlap sets;
      randomized sets; and `N = 10^4`, `10^5`, and `10^6` with fixed `k`.
- [ ] Unit tests cover every symbol degree and membership boundary, deterministic
      seeds/windows, signed positive/negative counts, XOR cancellation,
      checksum validation, incremental windows, deterministic peel order, and
      exact direction classification.
- [ ] Binary64 mapping tests freeze the exact u64 conversion, per-operation
      round-to-nearest-ties-to-even, correctly rounded square root, fixed
      evaluation order, `ceil`, minimum step, and safe-index failure. No
      implementation may substitute the rejected integer candidate under
      protocol version 1.
- [ ] Unit tests prove insufficient-symbol and non-peelable cores request more
      symbols, preserve prior decode work, and never emit an accepted partial
      result.
- [ ] Malformed arity/type/length, count overflow/underflow, all-zero false-pure,
      checksum collision fixtures, duplicate decoded IDs, resource-limit
      exhaustion, stale/wrong seed, count mismatch, and root mismatch fail with
      stable reason codes and bounded work.
- [ ] Property and fuzz tests compare encode/subtract/decode with a simple set
      symmetric-difference oracle across at least 100,000 deterministic seeds;
      every accepted result equals the oracle exactly.
- [ ] Set-commitment tests prove identical roots across insertion permutations,
      deletion/rebuild, restart serialization, and reference implementation;
      any omitted, extra, duplicated, or reordered fallback ID fails final root
      verification.
- [ ] Golden vectors are consumed by at least two independent implementations
      that produce byte-identical roots, symbols, peel traces, and decoded sets.
- [ ] Equal signed roots return before symbol generation; fixed `k` and `b`
      across increasing `N` satisfy the RFC reconciliation-byte bound and do not
      enumerate RDF.
- [ ] Fresh-process benchmarks run both the normative binary64 profile and the
      retained exact-integer experiment at `N = 10^4`, `10^5`, `10^6`, and
      `10^7` for at least three rotated repetitions, assert the exact decoded
      difference, and retain raw setup/stream/total time, symbols, canonical
      bytes, CPU/memory telemetry, and median/p95/max summaries. The normative
      baseline has a tracked regression gate.
- [ ] The module imports no RDF, SPARQL, SWM/VM, graph-storage, discovery,
      libp2p, or object-transfer implementation.
- [ ] Static schema/code tests find no `IbltProfileId`, `SymbolId`,
      content-addressed symbol/cache/range type, `WalObjectStore` admission path
      for reconciliation control data, or set element type other than
      `WalObjectId`.

---

## WAL-006 — Implement crash-safe WalStore and SQLite control state

**Focused RFC context:** Sections 3, 6.6, 8, 10, 14, 17, and 19.

### Objective

Create the single durable replicated-truth store for WAL objects, checkpoints,
admission, replay, and progress, while keeping RDF a separate rebuildable
projection.

### Scope and deliverables

- Implement the RFC SQLite schema for complete WAL objects, local-only object
  ranges, author lanes, set-commitment nodes, bounded IBLT cache, checkpoints,
  vectors, idempotency, admission, materialization, providers, and persistent
  retry queues.
- Use SQLite WAL mode, `synchronous=FULL`, foreign keys, explicit schema version,
  migrations, and one-writer transaction discipline.
- Implement atomic author-sequence/checkpoint/set-root finalization and staged
  remote admission without graph or network calls inside transactions.
- Store the rollback high-water in a separately protected database excluded
  from ordinary graph/WAL snapshot restore, per the frozen recovery decision.
- Implement bounded quarantine, orphan cleanup, integrity scan, and replay queue
  recovery.

### Acceptance area

- [x] Schema creation and migrations are deterministic, transactional, and
      backwards/forwards gated by explicit versions.
- [x] Fault injection at every insert, set update, checkpoint, commit, rollback,
      and process boundary yields either the old state or the complete new state.
- [x] No acknowledged WAL object is lost and no checkpoint references absent
      object, set-commitment, policy, or snapshot state.
- [x] Idempotency returns the original result for the same request digest and
      rejects key reuse with a different digest across restart.
- [x] Corruption/integrity failures produce `blocked` and never false `complete`
      or automatic graph mutation.
- [x] Queue, quarantine, and GC limits remain bounded under adversarial input.

---

## WAL-007 — Implement membership, checkpoints, head vectors, and authority lifecycle

**Focused RFC context:** Sections 3, 5, 6.6–6.8, 9, 12, 20, and freeze item 6.

### Objective

Make completeness explicit and fail-closed using existing DKG author, curator,
membership, and chain authority rather than provider inventory.

### Scope and deliverables

- Implement author lanes/epochs/sequences, one checkpoint per authored WAL object,
  set-extension validation, previous-checkpoint linkage, snapshots, and
  compaction floors.
- Implement signed membership checkpoints and exact disclosure views separated
  by collection, SWM/VM tier, public/private visibility, policy epoch, and key
  epoch.
- Implement sorted curator head vectors, expiry/skew, open/curated behavior,
  finalized chain frontier, unknown freshness, and persistent rollback guard.
- Implement authority key rotation, vector-epoch transition, HA/multi-signer or
  elected authority rules, emergency revocation, and high-water recovery as
  frozen by `WAL-001`.
- Reuse current membership/agent delegation/chain authorization surfaces.

### Acceptance area

- [x] A replica reports complete only for the exact author checkpoints named by
      a currently valid signed vector and membership checkpoint.
- [x] Stale, expired, rolled-back, forked, wrong-view, wrong-policy, and
      same-position/different-hash evidence fails closed with stable status.
- [x] Private roots and metadata are not served under `unknown-freshness`.
- [x] Curator key rotation, HA failover, rollback-file restore/loss, author epoch
      rotation, and open-author indexing tests match the frozen rules.
- [x] The curator cannot author content or replace an author's checkpoint; a
      serving cache has no authority beyond availability.
- [x] Existing DKG membership and delegation golden tests remain unchanged and
      pass through the adapter boundary.

---

## WAL-008 — Integrate private inline payload envelopes and Sender Key epochs

**Focused RFC context:** Sections 3, 5, 6.1, 9, 15, 17, and freeze items 1 and 5.

### Objective

Protect private WAL metadata and bytes while reusing existing Sender Key
membership/key-package distribution and preserving its authority semantics.

### Scope and deliverables

- Implement `DkgPayloadEnvelopeV1` entirely inside `WalObjectV1.payloadBytes`
  and bind all decryption-critical metadata into the complete WAL-object
  signature/identity and AEAD associated data.
- Derive per-object keys from the existing epoch key with the RFC HKDF domains;
  encrypt inline adapter content using AES-256-GCM and unique nonces.
- Enforce exact private view/key epoch authorization before returning head,
  root, count, ID, size, proof, provider hint, ciphertext, or plaintext.
- Integrate key rotation/removal with future serving and retention without
  promising retroactive revocation.
- Ensure public VM/tier transition objects reveal no private source identifiers
  or activity metadata.

### Acceptance area

- [x] Existing Sender Key membership and key-package vectors still decide who
      receives epoch keys; WAL code does not invent another membership source.
- [x] Valid encryption vectors decrypt exactly; wrong collection/view/author/
      sequence/key/nonce/policy/length/codec/media-type data fails authentication.
- [x] Nonce reuse, unsigned metadata, plaintext-hash advertisement, and
      deterministic-equality leakage are rejected by tests.
- [x] Unauthenticated, removed, stale-policy, wrong-view, downgrade, and probing
      callers receive a uniform denial with zero private metadata disclosure.
- [x] Key-epoch rotation stops future serving/writes to removed members while
      documentation states the non-retroactive limit accurately.
- [x] Public VM reconciliation fixtures contain no private SWM IDs, graph names,
      epochs, counts, or causal openings.

---

## WAL-009 — Implement bounded authenticated WAL wire protocols

**Focused RFC context:** Sections 7–9, 15, and 19.

### Objective

Expose the three versioned WAL protocol families over the existing raw
`ProtocolRouter`, with authorization-before-disclosure, canonical framing, and
hard resource bounds.

### Scope and deliverables

- Register `/dkg/10.1.0/wal-control`, `/wal-reconcile`, and `/wal-object`
  without using the reliable-message outbox as correctness storage.
- Implement unsigned-varint length framing, deterministic CBOR, request IDs,
  replay cache, timestamps, requester/target binding, identity/delegation proof,
  cancellation, deadlines, and uniform denial.
- Implement the complete frozen method catalog: `GET_CAPABILITIES`, `GET_HEAD`,
  `GET_VECTOR`, `GET_CHECKPOINT`, `ANNOUNCE_HEAD`, `CANCEL`,
  `GET_RECONCILIATION_SYMBOLS`, `GET_OBJECT_IDS`, `GET_OBJECT_RANGE`, and the
  common bounded `ERROR` response.
- Publish exact request/response tuple tables, numeric message/error codes,
  protocol negotiation rules, requester/provider state machines, and sequence
  diagrams for equal sets, IBLT delta sync, incremental symbol continuation,
  fallback enumeration, empty-node backfill, range resume, provider switch,
  cancellation, authorization denial, stale head, and malformed peer behavior.
- Keep provider discovery explicitly outside the three WAL wire families and
  document the handoff from an untrusted provider candidate to negotiated,
  identity-bound, authorized protocol requests.
- Bind every reconciliation response to the immutable signed head, seed, symbol
  offset/page cursor, and request. Bind every object range to `WalObjectId`,
  total canonical length, and byte offset.
- Enforce per-frame, symbol window, decoded-ID, fallback page, object, range,
  concurrency, queue, fan-out, temporary staging, and request-freshness limits
  before allocation or expensive validation.
- Preserve Iroh-inspired provider/path independence without adding an Iroh
  runtime dependency in protocol v1.

**Likely surfaces:** `packages/core/src/protocol-router.ts`,
`packages/agent/src/p2p/`, and `packages/wal/src/protocol/`.

### Acceptance area

- [x] All protocol conformance frames round-trip byte-exactly and reject
      non-canonical, truncated, trailing, oversized, replayed, stale, or
      misbound requests.
- [x] Every catalogued method and stable error code has valid, boundary, and
      invalid golden frames plus requester/provider transition tests; no
      undocumented message can affect reconciliation or object admission.
- [x] Authorization runs before private metadata lookup/serialization and before
      any private response byte is written.
- [x] Existing `/dkg/10.0.x/*` handlers and legacy sync behavior are unchanged in
      `legacy` and remain authoritative in `parallel`.
- [x] Slowloris, count/length mismatch, symbol bomb, fallback-page abuse,
      dishonest object length, range overflow, cancellation, timeout, queue
      saturation, and concurrent-stream tests stay within configured bounds.
- [x] Protocol negotiation cannot downgrade a private WAL request to legacy or
      another disclosure view.
- [x] Provider responses remain independently verifiable; session state is never
      used as proof of correctness.

---

## WAL-010 — Implement provider discovery, selection, failover, and cold start

**Focused RFC context:** Sections 2, 7, 9, 17, 20, and freeze item 7.

### Objective

Let an empty or reconnecting authorized node locate usable providers and switch
between them without making gossip, one peer, or one transport path a
correctness dependency.

### Scope and deliverables

- Implement the frozen public/private provider discovery path using existing
  peer resolver, membership, curator, agent directory, direct connections, and
  relays.
- Separate signed target discovery from availability hints; gossip and
  checkpoint nudges may wake reconciliation but never define completeness.
- Implement provider scoring, bounded fan-out, retry/backoff, request-boundary
  switching, cross-provider symbol windows and WAL-object ranges, and persisted
  availability hints.
- Implement authorized cold start for public and private collections without
  exposing private collection metadata to discovery infrastructure.

### Acceptance area

- [x] A node with no local WAL state obtains current authority evidence and at
      least one valid provider through the frozen bootstrap path.
- [x] Lost gossip, unavailable curator cache, stale hint, one malicious provider,
      and direct-to-relay path changes do not change the expected signed set.
- [x] Provider switching during symbol acquisition, fallback enumeration, and
      WAL-object range fetch converges to exact sets and bytes without duplicate
      durably recorded ranges.
- [x] Private discovery returns no collection/view/root/provider metadata to an
      unauthorized requester.
- [x] Retry state survives restart, respects concurrency/fan-out bounds, and
      avoids tight loops against malformed or unavailable peers.
- [x] All-provider-unavailable state reports `known-incomplete` or
      `unknown-freshness` accurately, never `complete`.

---

## WAL-011 — Implement remote admission, causal closure, and bounded quarantine

**Focused RFC context:** Sections 3, 6, 10.3, 12–17, and 20.

### Objective

Create one fail-closed path that turns fetched canonical bytes into admitted WAL
objects only after every identity, authority, content, causal, privacy, policy,
and VM prerequisite is satisfied.

### Scope and deliverables

- Stage fetched WAL objects until checkpoint inclusion, complete-object
  signature/ID/canonicality, policy, namespace, inline payload envelope, parents,
  base heads, cross-author permission, decryption, adapter version, limits, and
  relevant chain evidence validate.
- Fetch causal/content closure without unbounded recursion or accepting provider
  omission as deletion.
- Atomically admit a closed batch and persist affected logical-key work.
- Retain invalid input only in bounded quarantine with stable reason codes,
  provenance, retention, and operator inspection; never put it in canonical RDF.
- Make local, network, backfill, and replay paths call shared validation logic.

### Acceptance area

- [x] No incomplete WAL object, policy, or causal set changes canonical or
      shadow RDF.
- [x] Every validation step has focused valid/invalid tests and the documented
      fail-closed order, including private authorization before disclosure.
- [x] Parent cycles, excessive closure depth, cross-view references, policy
      substitution, author equivocation, and VM evidence substitution are
      rejected or blocked exactly as specified.
- [x] Atomic batch crash tests leave all WAL objects staged or the entire closed batch
      admitted and queued; no half-admitted causal state is visible.
- [x] Quarantine byte/time/count limits work across restart and cannot evict or
      overwrite valid canonical objects.
- [x] Replaying the same bytes through every ingress path yields the same
      admission result and stable reason code.

---

## WAL-012 — Implement RDF canonicalization, mutation encoding, and signed replay policy

**Focused RFC context:** Sections 6.2–6.3, 11, 12, and semantic compatibility goals.

### Objective

Encode transitions already accepted by the existing DKG semantic core into
deterministic opaque WAL payload bytes while preventing remote arbitrary SPARQL
execution. This task must not create a WAL-specific DKG or SPARQL semantic
evaluator.

### Scope and deliverables

- Implement blank-node-free canonical N-Quads, NFC/escaping/language rules,
  deterministic sorting/deduplication, skolem requirements, and state digests.
- Implement stable author-scoped logical keys and explicitly policy-authorized
  shared-write keys.
- Receive graph/subject replacements, explicit deletes/inserts, or whole-key
  deletion only after the existing DKG semantic core accepts the operation;
  encode that exact outcome into canonical `RdfMutationV1` manifests against
  declared base heads. `packages/wal` must contain no source-SPARQL parser or
  evaluator.
- Reject remote `SERVICE`, load/drop/global operations, nondeterminism, unrelated
  graph reads, escaping variables, unsupported functions, and limit violations.
- Implement signed `RdfPolicyV1` admission and adapter-version pinning as WAL
  replay/resource constraints. They MUST NOT replace existing membership,
  authorization, SWM/VM, verified-memory, finality, or crypto policy. General
  SHACL is not consensus logic in v1.

### Acceptance area

- [x] Canonicalization fixtures produce byte-identical N-Quads and state digests
      across supported runtimes and stores.
- [x] Existing DKG publish/share/update/delete golden cases encode to results
      with identical canonical RDF and authorization outcomes.
- [x] Code-path instrumentation proves the legacy-sync path and WAL
      accepted-outcome encoding boundary use the same semantic implementation;
      no operation-specific DKG decision is copied into `packages/wal`. The
      actual WAL replay invocation is an explicit `WAL-014` acceptance gate.
- [x] Existing semantic-core tests prove unsupported/nondeterministic SPARQL and
      graph-scope escape attempts fail before accepted-outcome encoding; WAL
      contains no independent parser or evaluator.
- [x] `parents`, `baseHeads`, `baseStateDigest`, `resultStateDigest`, touched keys,
      and graph/subject replacement scopes satisfy frozen replay relations.
- [x] Remote nodes receive only explicit canonical result bytes and never execute
      source query/audit bytes.
- [x] Policy substitution, unknown adapter version, oversized mutation, blank
      node, and shared-writer authorization negatives pass.

---

## WAL-013 — Implement local WAL commit and publisher shadow integration

**Focused RFC context:** Sections 3, 6, 10.2, 18.1, 19, and 20.

### Objective

Encode every eligible mutation accepted by the shared semantic core into a
durable shadow WAL object with idempotent API results, without changing current
synchronization authority.

### Scope and deliverables

- Wire publisher/share/update/delete/expiry paths to the shared semantic-core
  result encoder behind
  explicit `parallel` mode.
- Partition an accepted operation by eligible replication view. A public and
  private outcome produces one complete `WalObjectV1` in each exact namespace;
  neither a view mutation nor their batch is another synchronization atom.
  Key local heads and replay work by `(namespaceId, logicalKey)` so views,
  policy/key epochs, and tiers never collide.
- Encode the complete canonical adapter plaintext before acquiring the
  author-lane mutex. Complete public envelopes before the lane. Private
  envelopes are the sole exception: resolve the existing Sender Key epoch
  before the lane, then finalize only sequence-bound encryption and durably
  claim nonce uniqueness after sequence allocation inside the transaction.
  Perform no key selection, network, graph, membership, or semantic work there.
- Resolve idempotency, allocate sequence, bind the previous object, sign the
  complete `WalObjectV1`, update the set commitment, create the checkpoint, and
  commit atomically; do no network or graph work inside the transaction.
- Queue shadow materialization and send best-effort checkpoint nudges only after
  durable commit.
- Expose `walObjectId`, WAL status, materialization status, and checkpoint ID
  without falsely claiming global propagation.

**Likely surfaces:** `packages/publisher/src/dkg-publisher.ts`, share/update/
workspace handlers, `packages/agent/src/`, and `packages/wal/`.

### Acceptance area

- [ ] In `legacy`, public API responses and storage/network behavior remain the
      current baseline with zero WAL side effects.
- [ ] In `parallel`, each eligible per-view mutation successfully accepted by
      the shared semantic core produces exactly one matching durable WAL
      object/checkpoint and isolated shadow result. Public objects contain zero
      private RDF bytes, and dual-view objects retain independent namespace-
      scoped heads and replay work.
- [ ] Same idempotency key/digest returns the same `WalObjectId` across restart;
      same key/different digest fails deterministically.
- [ ] Crashes after every object-file/WAL/checkpoint/nudge/materialization
      boundary lose no acknowledged object and recover without manual repair.
- [ ] Shadow failure is visible and bounded but cannot mutate production graphs
      or silently convert WAL into the authoritative write path.
- [ ] p95/p99 latency and CPU/RSS overhead are recorded against `WAL-000` and
      satisfy the RFC shadow-write thresholds.

---

## WAL-014 — Implement deterministic replay/conflict adapter over the existing semantic core

**Focused RFC context:** Sections 3, 6.1–6.4, 12, 13, and conflict goals.

### Objective

Schedule identical admitted WAL-object sets deterministically, invoke the
existing DKG semantic core for every candidate transition, and retain explicit
conflict branches regardless of arrival, provider, retry, or replay order. This
task must not create a second implementation of DKG behavior.

The word `deterministic` qualifies replay scheduling, causal/conflict
bookkeeping, and repeatable invocation of the shared core. It does **not**
define a reducer, state machine, or semantic evaluator. WAL-014 consumes and
orders inputs to the one existing DKG/SWM/VM implementation.

### Scope and deliverables

- Build the per-logical-key causal DAG, validate protocol-level bases, find
  maximal accepted heads, choose a deterministic replay schedule, and compute
  frozen maximal-common-base candidates for incompatible heads.
- Define a narrow `DkgSemanticCore` adapter over the existing implementation.
  Current sync and WAL replay must call the same underlying functions for
  publish/share/update/delete/expiry, membership/authorization, SWM/VM,
  verified-memory, roots/receipts, finality/reorgs, and cryptography.
- Classify protocol-level causal compatibility from explicit mutation
  footprints and signed replay policy, then ask the shared semantic core to
  validate/apply every replace/patch/delete/tier branch. Do not copy DKG
  operation behavior into `packages/wal` or a WAL-only service.
- Preserve every incompatible maximal branch in reserved conflict projections;
  `WalObjectId` may order processing but never select a winner.
- Route `RESOLVE` through the existing authorization and semantic core after
  the adapter verifies that every current conflict head is referenced.
- Detect same-sequence author equivocation, retain evidence, block the lane, and
  require the frozen epoch/governance recovery.

### Acceptance area

- [x] Every replay/conflict scenario obtains its decision from the shared
      semantic core and then produces identical active-head, state, and
      conflict digests under all WAL-object-arrival and provider permutations.
- [ ] Instrumented current-sync and WAL-replay scenarios invoke the same semantic
      entry points and return the same outcomes; static/code review finds no
      duplicated DKG/SWM/VM/verified-memory/finality/crypto implementation.
- [x] Concurrent disjoint patch, same-key patch, replace/patch, replace/replace,
      delete/update, tier movement, multi-base, resolution, and equivocation
      vectors match the normative fixtures. Those fixtures consume
      semantic-core outcomes as inputs; they do not contain a DKG decision table.
- [x] No incompatible branch is dropped or made active by wall clock, arrival
      order, provider identity, or lexical `WalObjectId` winner selection.
- [x] Unauthorized, incomplete, stale-head, or partial `RESOLVE` objects fail
      without changing active/conflict state.
- [x] Resource limits bound causal depth, conflict heads, touched keys, and
      recomputation work with stable blocked/quarantine outcomes.
- [ ] Replay output matches the shared semantic oracle for all previously
      defined behavior. There is no permitted RFC divergence from established
      DKG semantics in this task; a desired semantic change belongs in the
      semantic core and applies to both synchronization mechanisms.
- [x] Naming, APIs, package boundaries, and operator output call this a
      replay/conflict adapter, never a DKG reducer or WAL semantic engine.

---

## WAL-015 — Persist shared-core results atomically and support rebuild

**Focused RFC context:** Sections 2, 3, 14, 17, 19, and rebuild goals.

### Objective

Persist the shared semantic core's complete projection outcome into isolated
RDF graphs with an atomic content/conflict/marker commit, making the graph store
rebuildable rather than a second replication or semantic truth.

### Scope and deliverables

- Add `applyWalProjectionAtomic` to the storage capability contract with guarded
  expected/new head digests, content mutations, conflict graphs, state digest,
  vector ID, and `APPLIED | GUARD_FAILED` outcome.
- Implement the Oxigraph reference path as one all-or-none transaction and exact
  marker post-read after lost responses.
- Persist adapter version, active-head-set digest, state digest, source vector,
  and materialization status in `urn:dkg:wal:projection`.
- Implement per-key locking, persistent retry, guard-failure recalculation,
  corruption detection, and full/selective projection rebuild from WAL.
- Keep the storage boundary semantically passive: it may validate guards and
  persistence integrity, but it must not choose heads, interpret DKG operations,
  resolve conflicts, or implement SWM/VM, verified-memory, authorization,
  finality, or cryptographic behavior.
- Do not import the replay scheduler into the persistence implementation. Its
  only semantic input is the complete projection outcome already returned by
  the shared core.
- Keep Blazegraph/non-atomic backends parallel-only until they pass the same
  fault-injection capability suite.

### Acceptance area

- [ ] Fault injection proves content, conflict graphs, and marker are always all
      old or all new; no partial canonical projection is observable.
- [ ] Lost response is resolved by exact marker/state post-read; a different
      value blocks/recalculates instead of being treated as success.
- [ ] Opposite replay scheduling and process restart reach identical markers and
      RDF state.
- [ ] Tests pass deliberately different complete semantic outcomes through the
      same persistence method and prove the persistence boundary stores or
      rejects them only by atomic guard/integrity rules, never by a second
      semantic decision.
- [ ] A locally complete WAL rebuilds an empty/corrupt shadow projection with
      zero network payload transfer and exact semantic digests.
- [ ] Production reads never include shadow graphs in `parallel` mode.
- [ ] Backend capability tests explicitly mark Oxigraph eligible and keep every
      failing backend ineligible for authoritative `wal` mode.

---

## WAL-016 — Feed VM/finality/reorg events into the existing semantic core

**Focused RFC context:** Sections 5, 6.4–6.5, 12, 16, and VM measurable goals.

### Objective

Feed admitted WAL records plus VM/finality/reorg events into the existing chain
validator and DKG semantic core, while representing SWM-to-VM movement causally
and without leaking private SWM metadata. This task adds no second VM state
machine.

### Scope and deliverables

- Encode/decode the frozen two-sided/opaque `MOVE_TIER` representation and source/
  target view authorization.
- Bind VM WAL objects to existing UAL/KA identity, author, context graph, root,
  assertion version/count, receipt, transaction/log location, block hash, and
  current network finality policy.
- Allow durable admission before activation; send activation evidence through
  the current chain adapter and shared semantic core, then persist their outcome
  and verified frontier.
- Feed canonical-block-hash changes from the existing watcher through the same
  semantic core; on reorg/loss of finality persist its pending/last-valid-SWM
  outcome without deleting WAL history.
- Ensure an author field can only request stricter finality, never weaken policy.

### Acceptance area

- [ ] Existing valid VM lifecycle vectors remain valid and every existing invalid
      vector remains rejected through the same chain/semantic-core boundary.
- [ ] Instrumentation proves current sync and WAL event replay invoke the same
      VM/finality/reorg implementation and SWM/VM state model; no WAL-only VM
      transition table or crypto validation exists.
- [ ] Premature, substituted author/root/receipt/block/log, stale version, wrong
      CG, insufficient finality, and reorg cases never produce active VM state.
- [ ] Valid finalized transition atomically activates VM and supersedes the
      corresponding SWM view; reorg deterministically restores prior valid SWM.
- [ ] Public target objects/responses disclose none of the private source IDs,
      graph names, epochs, counts, or causal shape.
- [ ] Chain policy reconfiguration and stored-frontier revalidation follow the
      frozen rule across restart.
- [ ] WAL sync and legacy sync produce identical VM API state and canonical RDF
      for the golden corpus because both invoke the same semantic code paths.

---

## WAL-017 — Implement deletion, expiry, snapshots, custody, and compaction

**Focused RFC context:** Sections 3, 6.6, 17, and freeze item 2.

### Objective

Bound served WAL history without converting absence into deletion, losing
conflicts, forging authorship, or resurrecting stale state.

### Scope and deliverables

- Implement signed causal deletes and policy-authorized expiry bound to a signed
  vector/block frontier; local wall time may schedule but not hide state alone.
- Feed delete/expiry requests through the existing DKG semantic core before
  encoding or replay; the WAL task owns causal durability and retention, not a
  second deletion or expiry policy.
- Implement author-scoped snapshot WAL objects/manifests containing live logical
  keys, author heads, inline state digests/bytes, conflict references, covered root,
  policy, adapter, and VM frontier.
- Implement new-epoch compaction, baseline snapshot ID, compaction floor, signed
  expiring custodian receipts, quorum/retention grace, removed-custodian policy,
  and safe serving GC.
- Preserve tombstones and unresolved conflicts in the baseline; keep cross-author
  references as references rather than curator/author substitution.

### Acceptance area

- [ ] Offline/restart/compaction tests never resurrect deleted or expired state.
- [ ] Local-clock-only expiry, unauthorized expiry, missing base heads, and stale
      frontier fail without hiding state.
- [ ] Snapshot bytes, authorship, covered checkpoint/root, policy, adapter, VM
      frontier, tombstones, and conflicts verify against normative vectors.
- [ ] A peer below the floor installs the author baseline before delta
      reconciliation and validates closure without fetching removed history.
- [ ] GC is impossible before required durable replicas/receipts and grace; stale,
      expired, removed, or forged custody evidence cannot authorize deletion.
- [ ] Crash tests at snapshot install, epoch rotation, receipt persistence, floor
      advance, and physical GC retain one safe authoritative WAL state.

---

## WAL-018 — Implement genesis migration, backfill, and rebuild tooling

**Focused RFC context:** Sections 17–18, backfill sequence, and measurable goals.

### Objective

Enter parallel mode from existing SWM/VM state and bring empty, stale, or rebuilt
nodes to current authenticated state without inventing pre-WAL causal history.

### Scope and deliverables

- Build a maintenance-barrier tool that enumerates only known SWM/VM graph
  families, canonicalizes accepted state, attributes author lanes, records
  policy/adapter/VM frontier, and produces signed genesis snapshots/checkpoints/
  vectors.
- Implement the frozen `LegacyGenesisV1` quarantine/visibility policy for
  unclaimable pre-WAL state without pretending it has original author
  signatures. `LegacyGenesisV1` labels provenance, not SWM/VM semantics.
- Implement incremental catch-up, snapshot-plus-delta, genesis bootstrap, and
  projection-only rebuild through the same verifier/admission/replay adapter and
  shared semantic-core path.
- Produce dry-run reports, resumable execution, deterministic manifests, abort
  safety, and post-barrier proof that every new mutation creates a shadow WAL
  object.

### Acceptance area

- [ ] Repeating genesis against the same maintenance snapshot produces the same
      canonical state/manifest digests and never mutates production data in
      dry-run mode.
- [ ] Provable author state is signed only by that author; ambiguous/unclaimable
      rows remain quarantined unless explicit migration policy authorizes a
      clearly labeled pre-WAL provenance view.
- [ ] Empty, stale, below-floor, and projection-only nodes reach exact target
      roots, complete WAL objects, RDF, conflict, tombstone, and VM state.
- [ ] Backfill performs no remote graph enumeration; local complete-WAL rebuild
      performs zero network payload transfer.
- [ ] Barrier abort/resume and crashes at every snapshot/checkpoint/vector step
      preserve current-sync authority and never omit a post-barrier mutation.
- [ ] Backfill p95 is no worse than the same-data/link current-sync full-sync baseline
      and emits the required evidence manifest.

---

## WAL-019 — Implement reconciliation driver and complete network shadow protocol

**Focused RFC context:** Sections 2, 3, 7–10, 17–19, and reconciliation sequence.

### Objective

Join signed target discovery, rateless IBLT reconciliation, and WAL-object range
retrieval into one durable pull-correct byte protocol operating across upgraded
nodes. After complete-object admission it may enqueue the separate
replay/conflict adapter, but reconciliation itself handles bytes and
`WalObjectId` sets only.

### Scope and deliverables

- On connect, nudge, and periodic heartbeat, obtain membership/vector/
  checkpoints, compare signed roots, choose baseline, stream rateless IBLT
  symbols, verify the decoded remote set or bounded fallback, fetch remote-only
  complete WAL objects by ranges, admit closed work, and enqueue affected keys
  for the separate replay/conflict adapter.
- Enforce a dependency boundary: reconciliation code MUST NOT import or invoke
  RDF/SPARQL interpretation, DKG operation semantics, SWM/VM state transitions,
  verified-memory, conflict decisions, finality/reorg rules, or crypto beyond
  generic protocol identity/signature/authenticated-transport verification.
- Persist reconciliation sessions, provider/retry state, missing IDs/ranges,
  queue priorities, cancellation, backpressure, and restart recovery.
- Add best-effort checkpoint gossip/nudges only as wakeups; dropped/reordered
  nudges must not affect eventual correctness.
- Enforce four reconciliation streams per peer, two WAL-object range streams per namespace/peer, global
  bounded materialization, policy priority, and every frozen resource limit.
- Run exclusively in isolated WAL/shadow namespaces while legacy sync remains
  authoritative.

### Acceptance area

- [ ] Equal signed roots exchange no IBLT symbols, fallback IDs, or WAL-object
      bytes and perform zero triplestore enumeration after current heads are
      known.
- [ ] Static dependency and instrumented devnet tests prove reconciliation sees
      only signed control bytes, `WalObjectId` sets, and complete-object ranges;
      semantic work begins only after atomic admission in the separate adapter.
- [ ] Missed nudge, opposite arrival, reconnect, offline stale peer, late join,
      partial transfer, provider switch, restart, and unavailable-provider cases
      converge to the exact signed target.
- [ ] Every queue/retry/session survives restart without duplicate activation,
      lost work, tight retry loops, or false completion.
- [ ] Backpressure and limits bound heap, disk staging, network fan-out, proof
      work, signatures, chain checks, conflicts, and materialization.
- [ ] Shadow byte roots plus shared-core RDF/state digests, conflicts, deletion,
      expiry, and VM lifecycle match the `WAL-000` semantic oracle.
- [ ] Disabling `parallel` stops the protocol cleanly and leaves the legacy-sync path
      untouched and authoritative.

---

## WAL-020 — Implement operator APIs, readiness, metrics, and admin controls

**Focused RFC context:** Sections 19–21 and measurable operational goals.

### Objective

Make protocol truth observable enough to distinguish complete, behind, stale,
blocked, and materialization-lag states without inspecting SQLite or RDF by
hand.

### Scope and deliverables

- Expose per collection/view/author membership, vector, checkpoint, expiry,
  freshness source, rollback high-water, root/count, compaction floor, and
  snapshot ID.
- Expose missing WAL-object IDs/counts, IBLT symbol/fallback state, object ranges, durable WAL head, admission/
  quarantine reasons, materialization frontier/lag, active/conflict/VM-pending
  keys, provider/retry/queue state, and cutover state.
- Implement exact readiness values: `complete`, `known-incomplete`,
  `unknown-freshness`, `materialization-lag`, and `blocked`.
- Add bounded admin operations for force reconcile, rebuild, quarantine inspect,
  snapshot/genesis dry-run, and signed conflict resolution; authorize and audit
  every mutation.
- Add structured logs, metrics, traces, and lifecycle correlations without
  leaking private IDs/content.

### Acceptance area

- [ ] Every forced failure/readiness scenario returns the exact stable status and
      reason after restart; no internally known failure reports `complete`.
- [ ] Expected/local roots, counts, missing work, lag, freshness, provider, and
      retry state reconcile with direct test inspection of the WAL store.
- [ ] Private endpoints redact or deny roots, IDs, sizes, proofs, providers, and
      payload metadata for unauthorized operators/callers.
- [ ] Force/admin operations are authenticated, bounded, idempotent where
      applicable, audit logged, and cannot bypass admission/cutover invariants.
- [ ] Dashboard/API load does not enumerate all graphs or materially block WAL
      writer/reconciliation transactions.
- [ ] Publish/share returns durable `walObjectId`, WAL/materialization status, and
      checkpoint ID with no false global-propagation claim.

---

## WAL-021 — Build fault-injection, adversarial, and security acceptance suite

**Focused RFC context:** Invariants; Sections 7–18, 21–23; all measurable safety goals.

### Objective

Convert the RFC's correctness, crash, privacy, abuse, and adversarial claims into
repeatable release-blocking tests.

### Scope and deliverables

- Inject crashes at every object-range/file, SQLite, checkpoint, vector, admission,
  materialization, snapshot, compaction, genesis, reconciliation, and cutover
  durable boundary.
- Build malicious-provider fixtures for IBLT omission/substitution, malformed
  symbols, residual cores, fallback-page omission, dishonest object lengths,
  forks, stale vectors, equivocation, closure bombs, frame/length bombs, slow
  streams, replay, downgrade, and provider switching.
- Build private authorization probes for unauthenticated/removed/stale/wrong-view/
  wrong-epoch callers and public/private tier metadata leaks.
- Build VM substitution/finality/reorg and conflict permutation suites.
- Add architectural tests that fail if WAL reconciliation gains semantic
  dependencies or if WAL replay bypasses/reimplements the shared DKG semantic
  core, SWM/VM model, verified-memory logic, or cryptographic logic.
- Make the reconciliation dependency test structural: files below the
  reconciliation boundary may import only byte/ID/protocol primitives and
  generic hashing. They may not import RDF, SPARQL, publisher, agent semantic,
  SWM/VM, chain, membership, or DKG cryptographic modules.
- Integrate sanitizer/fuzz/property tests and bounded resource assertions into CI.

### Acceptance area

- [ ] At least 100 randomized runs per durable crash boundary yield zero lost
      acknowledged WAL objects, partial canonical projections, false completion, or
      manual repair.
- [ ] Every security negative is rejected before unauthorized disclosure or
      projection activation and reports a stable bounded reason.
- [ ] Malicious provider omission/substitution cannot satisfy checkpoint/set-root,
      decoded-root, fallback-root, or complete-WAL-object verification or change
      expected signed state.
- [ ] Resource attacks stay within configured memory, disk, CPU-work, queue,
      concurrency, and time limits.
- [ ] Same-sequence equivocation is retained and blocks the lane; it is never
      overwritten by arrival order.
- [ ] Shared-core call tracing and dependency checks prove two synchronization
      mechanisms but one semantic/verified-memory/crypto implementation.
- [ ] The suite is deterministic enough for CI, archives failure seeds, and can
      replay an individual seed locally.

---

## WAL-022 — Build measurable-goal benchmark and evidence pipeline

**Focused RFC context:** Section 1 measurable criteria; Sections 18.2, 20, and 21.

### Objective

Produce reproducible evidence for every measurable success criterion and make
regression against the `WAL-000` baseline a release gate.

### Scope and deliverables

- Implement profiles for semantic/crypto parity, exact convergence, equal-set
  cost, fixed-delta scaling, backfill/rebuild, resume, write overhead, freshness,
  operational diagnosis, and cutover rehearsal.
- Exercise `N = 10^4`, `10^5`, `10^6` with controlled `k` and `b`, identical
  data/IDs, network shaping, roster, chain snapshot, durability, and faults.
- Capture median/p95/p99, bytes, request/control/proof counts, retransmission,
  CPU seconds, peak RSS, disk, triplestore operations, roots, and state digests.
- Generate a signed/evidenced report bundle with raw machine-readable results and
  human-readable pass/fail against every RFC threshold.
- Prevent faster hardware, smaller data, changed durability, or missing faults
  from being accepted as a comparison.

### Acceptance area

- [ ] Seven-day full-fleet shadow soak covers at least 1,000,000 accepted
      mutations and every supported type with zero unexplained semantic/crypto
      divergence.
- [ ] Equal-set, fixed-delta control growth, resume, backfill, write latency,
      CPU/RSS, VM, privacy, and exact-convergence results meet every numeric RFC
      requirement.
- [ ] Each profile runs at least three times and records environment parity with
      the current-sync baseline.
- [ ] Every cutover gate links to a reproducible evidence artifact, raw inputs,
      commands, commit, configuration, and exact digests.
- [ ] CI fails on threshold regression or missing evidence rather than publishing
      a partial green report.
- [ ] Large receipts remain CI artifacts or intentional external result storage;
      the repository stays free of generated benchmark pollution.

---

## WAL-023 — Implement signed network cutover and fail-closed authority switch

**Focused RFC context:** Sections 3, 6.9, 18.2–18.3, 20–23.

### Objective

Implement the single coordinated transition from legacy synchronization
authority to WAL synchronization authority without per-collection mixed mode,
silent downgrade, or configuration override. The DKG semantic core and SWM/VM
model do not switch.

### Scope and deliverables

- Implement canonical `NetworkWalCutoverV1`, collection-vector manifest,
  network-authority signature, activation frontier, epoch, required versions,
  and `legacySyncDisabled=true` validation.
- Persist the accepted `CutoverId` outside ordinary graph/WAL restore rollback
  domains and require it at authoritative startup.
- Implement maintenance steps: stop writes, disable/drain legacy initiation,
  finalize author checkpoints, issue final vectors, reconcile all nodes, verify
  parity/zero lag, sign manifest, restart, promote/rebuild, and resume.
- Implement frozen active-node/author inventory, offline/decommissioned handling,
  late-node bootstrap, authority rotation, pre-activation abort, and post-write
  rollback procedure.
- Reject registration of legacy-sync protocols and graph-persistence paths that
  bypass the shared semantic core/atomic persistence boundary after activation.

### Acceptance area

- [ ] Every authoritative node validates, persists, and reports the same signed
      `CutoverId`, manifest, protocol/adapter version, and activation frontier.
- [ ] Missing, mismatched, stale, rolled-back, wrong-network, wrong-version, or
      invalidly signed cutover evidence fails startup closed.
- [ ] Before WAL writes resume, any failed gate aborts to legacy sync authority without
      accepting a WAL-sync-authoritative write.
- [ ] After activation, zero legacy sync handlers, initiators, fallback routes, or
      semantic-core-bypassing canonical graph writers are reachable.
- [ ] Offline/late nodes cannot speak legacy; they authenticate the cutover and
      complete snapshot/delta bootstrap before readiness.
- [ ] Cutover/restart/crash rehearsal proves exactly one authority at every
      synchronization boundary and documents the maintenance-only rollback after
      WAL writes, while proving the semantic implementation is unchanged.

---

## WAL-024 — Run full-fleet shadow soak, cutover rehearsal, and legacy retirement

**Focused RFC context:** Entire RFC, especially Sections 1, 18, 21–23.

### Objective

Prove the complete protocol against production-scale behavior, execute the
signed hard-cutover decision process, and delete superseded legacy
synchronization paths only after all evidence gates pass.

### Scope and deliverables

- Deploy `parallel` mode to the complete upgraded inventory with all active
  authors and every production write path emitting WAL.
- Run semantic/query parity, byte-root equality, conflicts, lifecycle, private,
  VM, fault, resource, backfill, rebuild, and seven-day soak gates.
- Rehearse the full maintenance/cutover/abort/late-node procedure with the exact
  signed manifests and inventories intended for release.
- Produce a go/no-go evidence review. Do not waive failed or missing goals by
  changing the benchmark after the run.
- After an approved real cutover only, remove legacy-sync graph enumeration,
  graph-page protocols, recovery cursors, and handlers; retain the shared DKG
  semantic core/SWM/VM/verified-memory/crypto implementation and only the
  explicit emergency read-only export/recovery tool allowed by the RFC.

### Acceptance area

- [ ] Every prior task acceptance area is complete and linked to exact commits and
      reproducible evidence; no implementation-freeze item remains open.
- [ ] All expected author roots/counts, complete WAL objects, projection/conflict digests,
      lifecycle states, private decisions, and VM states match across the fleet.
- [ ] Seven-day/million-mutation soak and every measurable numeric threshold pass
      on comparable production-scale infrastructure.
- [ ] Cutover rehearsal covers success, every pre-activation abort boundary,
      restart, unavailable provider, offline node, and late return with one
      authority throughout.
- [ ] The real cutover requires explicit network/operator approval and the signed
      manifest; this planning task does not itself authorize production cutover.
- [ ] Legacy-sync deletion occurs only after WAL sync authority is active and
      stable; final code search, protocol probe, and runtime tests prove one sync
      mechanism and the unchanged single semantic stack remain.
- [ ] Final documentation explains operator configuration, readiness, recovery,
      non-retroactive private-key limits, and the absence of live legacy-sync
      fallback.
