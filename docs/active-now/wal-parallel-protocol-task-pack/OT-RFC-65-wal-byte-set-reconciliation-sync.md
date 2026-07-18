---
status: implementation-proposal
version: 0.4
audience: protocol, agent, storage, publisher
protocol_version: 1
---

# OT-RFC-65: WAL-Replicated SWM/VM

## Abstract

This RFC replaces triplestore-level SWM/VM synchronization with a generic
write-ahead-log replication protocol. The protocol reconciles authenticated
sets of immutable record IDs, transfers the exact missing content-addressed
bytes with verified resumable chunks, and durably admits them without knowing
anything about RDF graphs or SPARQL. RDF remains central to the product, but it
becomes a deterministic projection: a versioned adapter compiles eligible local
SPARQL mutations into canonical RDF byte manifests, validates causal and policy
preconditions, retains incompatible branches, and atomically materializes the
accepted state into SWM/VM query graphs.

Each author signs its own WAL records and checkpoints. A curator signs
membership and bounded-freshness vectors naming the exact author checkpoints a
complete replica must hold, while the chain remains authoritative for VM
identity and finality. Serving peers are untrusted caches. Pull-based set
reconciliation is the correctness path; gossip is only a latency hint. Private
authorization is checked before disclosing roots, IDs, sizes, proofs, or bytes,
and private payloads remain encrypted under the existing membership key model.

Protocol version 1 fixes deterministic CBOR, BLAKE3 object identities, a
deterministic 16-way record-set tree, fixed-size BLAKE3 blob chunks and range
proofs, four raw libp2p protocols, durable SQLite WAL control state, and an
atomic RDF materializer contract. The transport design takes inspiration from
Iroh's separation of content identity, provider choice, resumable verified byte
transfer, and transport path selection, but does not require an Iroh runtime.

Crash recovery, reconnect, late join, backfill, and projection rebuild all use
the same admission and replay path. A receiver either reconciles retained WAL
records or installs an authenticated author snapshot and then reconciles the
post-snapshot delta. Existing SWM/VM data enters through a signed genesis
barrier; this preserves current authenticated state but does not invent causal
history for mutations that predate the WAL.

Deployment is deliberately parallel but authority is not. The existing graph
path remains production-authoritative while the complete WAL protocol runs in
shadow across the upgraded fleet. After fleet-wide parity, failure, security,
rebuild, and throughput gates pass, one signed network cutover disables legacy
sync and makes WAL the only write authority. There is no per-collection mixed
authority or live legacy fallback after writes resume. A separate companion
document compares this design with OT-RFC-64 / OriginTrail dkgv10-spec PR #144.

## 0. Decision

Build a complete WAL replication protocol beside the current graph-sync stack.
The current stack remains authoritative while both systems run in parallel.
After the WAL path passes the acceptance gates, pause writes, sign one network
cutover manifest, switch every collection and node to WAL authority, and disable
the legacy sync handlers. There is no per-collection gradual migration, no
mixed authoritative mode, and no live legacy fallback after cutover.

The permanent boundary is:

> Replicate authenticated immutable records and content-addressed bytes. Treat
> RDF graphs as a deterministic, rebuildable query projection.

The WAL proves what was committed. The graph adapter validates RDF semantics and
materializes query state. A graph database is still central to the product, but
it is no longer required to prove replication history or completeness.

## 1. Scope

### Goals

- Store-independent synchronization for SWM and VM.
- Work proportional to missing records and blob chunks, not all stored graphs.
- Exact replay after crashes, source changes, deletion, expiry, and late join.
- One admission and reducer path for local writes, live delivery, reconnect,
  recovery, and rebuild.
- Deterministic graph projection and explicit conflict retention.
- Existing DKG membership, private-content, authorship, and chain-finality rules.
- A full parallel implementation followed by one hard cutover.

### Measurable success criteria

The WAL path is successful only when it preserves existing DKG semantics and
meets the following objective gates. Implementation completion by itself is not
a success criterion.

For reconciliation measurements:

- `N` is the total committed record count in the compared author lanes;
- `k` is the number of missing records;
- `b` is the total content bytes referenced only by those missing records.

| Goal | Measurement | Required result before cutover |
|---|---|---|
| **SWM/VM semantic compatibility** | Replay the existing publish, share, update, delete, expiry, membership, private-access, VM-finality, and reorg golden corpus through both paths. Compare authorization decisions, active/conflict state digests, canonical RDF, API-visible lifecycle state, and VM status. | 100% identical results for all previously defined behavior. Zero unexplained divergence during a seven-day full-fleet shadow soak covering at least 1,000,000 accepted mutations and every supported mutation type. |
| **Existing crypto compatibility** | Run the existing author, curator, membership, Sender Key, KA-root, receipt, and chain-validation vectors through the adapter boundary. | 100% of valid vectors remain valid and 100% of invalid vectors remain rejected. The WAL layer must not independently redefine membership, decryption authority, KA identity, or VM finality. |
| **Exact convergence** | Reconcile healthy replicas from equal, partially missing, opposite-arrival, stale-peer, snapshot, and genesis states. Compare checkpoint IDs, record roots/counts, blob completion, projection markers, active-state digests, and conflict digests. | Every authorized healthy replica reaches the exact signed target vector with zero missing records or blobs and identical projection/conflict digests. |
| **Equal-set cost** | Start with current cached membership/checkpoints and equal record-set roots for `N = 10^4`, `10^5`, and `10^6`. | After the signed head exchange: zero set-tree descent, record transfer, blob transfer, and triplestore enumeration. Cost must not grow with stored graph count. |
| **Delta-proportional work** | Hold `k` and `b` fixed while increasing `N` from `10^4` to `10^6`, using the same missing IDs and byte payloads. | Record and blob payload bytes remain exactly constant; reconciliation control/proof bytes increase by no more than 50%; triplestore enumeration remains zero. |
| **Backfill and rebuild** | Test empty join, below-compaction-floor join, genesis bootstrap, and projection-only rebuild against the same signed target. | 100% exact target-root and projection parity; zero deleted/expired-state resurrection; no graph enumeration during network backfill; a locally complete WAL rebuild performs zero network payload transfer. Backfill p95 duration must be no worse than the current full graph-sync baseline on the same data and link. |
| **Interrupted transfer efficiency** | Interrupt each blob stream after every chunk boundary and at randomized positions inside a chunk; resume from the same and another provider. | Zero already-verified chunks retransmitted. At most one incomplete 64 KiB chunk is retransmitted per interrupted stream. Final `BlobId` and bytes are exact. |
| **Crash safety** | Inject a process crash at every durable boundary listed in the acceptance tests, with at least 100 randomized runs per boundary. | Zero partial canonical projections, lost acknowledged records, false `complete` states, or manual repairs. Every restart converges automatically to the old projection plus pending replay or the fully committed new projection. |
| **Conflict determinism** | Replay every conflict fixture under all record-arrival permutations and provider orders. | 100% identical active-head, state, and conflict digests. No incompatible branch is silently discarded, and no `RecordId` ordering is used as a winner rule. |
| **Private-data non-disclosure** | Exercise unauthenticated, removed-member, stale-policy, wrong-view, wrong-key-epoch, downgrade, proof-probing, and malformed requests. | Zero private roots, counts, IDs, sizes, proofs, ciphertext, or plaintext disclosed beyond a uniform denial response; zero unauthorized projection activation. |
| **VM safety** | Exercise valid, premature, substituted, reverted, and reorged VM evidence using the existing chain-validation corpus. | Zero VM activations without current identity/root/receipt/finality validation; 100% deterministic return to pending and restoration of the last valid SWM state after simulated reorg evidence. |
| **Write-path overhead** | Compare legacy-authoritative and shadow-WAL local writes on identical hardware, data, durability settings, and workloads. | WAL shadowing adds no more than 20% to p95 publish/share latency, 30% to p99 latency, and 25% to peak daemon RSS or CPU seconds. No graph call occurs inside the WAL SQLite transaction. |
| **Operational diagnosis** | Force every readiness state and failure reason through API and restart. | 100% of non-complete collections expose the expected checkpoint, local root/count, exact missing records/ranges, materialization lag, freshness source, retry state, and stable reason code. No internally known failure is reported as `complete`. |
| **Hard-cutover safety** | Rehearse the maintenance barrier, final reconciliation, signed cutover, restart, late-node return, and pre-activation abort on the full deployment inventory. | 100% of authoritative nodes persist and load the same `CutoverId`; zero legacy protocol handlers or direct graph writers remain after activation; a missing/mismatched ID fails closed; every pre-activation abort returns to legacy authority without accepting WAL-authoritative writes. |

Performance comparisons must use the same hardware, network shaping, dataset,
roster, chain snapshot, adapter version, durability settings, and fault schedule.
Run each performance profile at least three times and report median, p95, p99,
bytes, request counts, CPU seconds, peak RSS, and triplestore operations. A pass
may not be claimed from a faster environment or a smaller workload than its
legacy baseline.

### Non-goals

- No total order or consensus across independent authors.
- No remote execution of arbitrary SPARQL text.
- No wall-clock last-write-wins.
- No replication of database-engine WAL files.
- No Iroh runtime dependency in protocol version 1.
- No compression on the wire in protocol version 1.
- No live dual-authoritative or fallback mode after cutover.

## 2. Architecture

```mermaid
flowchart LR
  A[Author/API] --> C[Mutation compiler]
  C --> B[BlobStore]
  C --> W[WalStore + SetIndex]
  W --> H[Signed author checkpoint]
  H --> V[Signed curator head vector]
  V --> R[Set reconciliation]
  R --> B
  R --> W
  W --> D[Deterministic RDF reducer]
  D --> M[Atomic materializer]
  M --> G[SWM/VM graph projection]
  X[Chain validator] --> D
  P[Signed policy] --> D
```

### Components

| Component | Responsibility |
|---|---|
| `WalStore` | Durable canonical records, checkpoints, vectors, idempotency, admission state. |
| `BlobStore` | Immutable payload bytes, verified chunks, resume bitmap, final root verification. |
| `SetIndex` | Deterministic authenticated set tree over `RecordId`. |
| `CollectionAuthority` | Membership, author authorization, private-view authorization, freshness vector. |
| `ReconciliationDriver` | Compare sets, fetch records, fetch blob chunks, admit closed batches. |
| `RdfReducer` | Compute active heads, state, conflicts, deletion, expiry, and tier transitions. |
| `RdfMaterializer` | Atomically apply one logical-key projection and its WAL marker. |
| `VmChainValidator` | Verify KA identity, root, version, receipt, finality, and reorg status. |

### Authority

- An author signs its records and author checkpoints.
- The curator signs membership and bounded-freshness head vectors.
- The chain remains authoritative for VM identity and finality.
- Serving peers are untrusted caches.
- The WAL record set is replicated truth.
- RDF is the validated query projection of that truth.

## 3. Required invariants

1. **Immutable identity:** one ID names exactly one canonical signed record or
   blob.
2. **Authorization before disclosure:** private roots, IDs, sizes, proofs, and
   bytes are returned only after current membership authorization.
3. **Explicit completeness:** synchronization targets the exact author
   checkpoints named by a valid curator vector, never a provider's incidental
   local inventory.
4. **Pull is correctness:** gossip and push only reduce latency.
5. **WAL before RDF:** records and all referenced blobs are durable before
   materialization.
6. **Deterministic projection:** identical admitted sets, policy, adapter
   version, and finalized chain view produce identical active state and
   conflicts.
7. **Deletion is a record:** absence from a response never means deletion.
8. **No silent conflict loss:** incompatible concurrent heads remain visible
   until an authorized signed resolution references all of them.
9. **Bounded resources:** every frame, proof, chunk, record, batch, queue, and
   conflict fan-out has a fixed limit.
10. **One authoritative switch:** before cutover the legacy path owns production;
    after cutover the WAL path owns production.

## 4. Canonical encoding, hashes, and signatures

### 4.1 Control encoding

All records, checkpoints, vectors, manifests, and protocol control frames use
RFC 8949 deterministic CBOR with this profile:

- integer map keys only;
- definite-length maps, arrays, strings, and byte strings;
- shortest integer representation;
- map keys ordered by encoded key bytes;
- UTF-8 strings normalized to NFC;
- no floats, tags, indefinite lengths, or duplicate keys;
- set-like arrays sorted lexicographically by their canonical bytes and deduped;
- a decoder rejects non-canonical bytes instead of re-encoding them;
- schema fields use the integer keys `0..N` in the exact order shown in this
  document; removed fields remain reserved and are never renumbered.

IDs are raw 32-byte values on the wire. Addresses are raw 20-byte EVM
addresses. Counters are unsigned 64-bit integers.

### 4.2 Signatures

Protocol version 1 reuses the current DKG agent/curator secp256k1 authority.

```text
recordDigest = BLAKE3("dkg-wal-record-sign-v1\0" || canonicalUnsignedRecord)
checkpointDigest = BLAKE3("dkg-wal-checkpoint-sign-v1\0" || canonicalUnsignedCheckpoint)
membershipDigest = BLAKE3("dkg-wal-membership-sign-v1\0" || canonicalUnsignedMembership)
vectorDigest = BLAKE3("dkg-wal-vector-sign-v1\0" || canonicalUnsignedVector)
cutoverDigest = BLAKE3("dkg-wal-cutover-sign-v1\0" || canonicalUnsignedCutover)
signature = EIP191_secp256k1_sign(the corresponding 32-byte digest)
```

Signatures are exactly 65 bytes, recoverable, low-S, and use normalized recovery
bits. Verification recovers the signer address and compares it with the signed
author or curator field.

### 4.3 Object IDs

```text
RecordId = BLAKE3("dkg-wal-record-v1\0" || canonicalSignedRecord)
MembershipCheckpointId = BLAKE3("dkg-wal-membership-v1\0" || canonicalSignedMembership)
CheckpointId = BLAKE3("dkg-wal-checkpoint-v1\0" || canonicalSignedCheckpoint)
VectorId = BLAKE3("dkg-wal-vector-v1\0" || canonicalSignedVector)
CutoverId = BLAKE3("dkg-wal-cutover-v1\0" || canonicalSignedCutover)
```

## 5. Namespace and disclosure views

Replication roots are separated by disclosure scope so a public VM peer cannot
learn private SWM record IDs or activity counts.

```text
CollectionKey {
  networkId,
  contextGraphId,
  subGraphName | null
}

ReplicationViewKey {
  collection,
  tier: SWM | VM,
  visibility: PUBLIC | PRIVATE,
  policyEpoch: u64,
  keyEpoch: u64 | null
}
```

A private request is authorized for one exact view. A member may reconcile
several views, but roots are never merged across visibility or key epochs.
`MOVE_TIER` links source and target views by signed record references without
making them one disclosure set.

## 6. Protocol objects

### 6.1 `WalRecordV1`

```text
WalRecordV1 {
  version: 1,
  view: ReplicationViewKey,
  type: PUT | DELETE | MOVE_TIER | RESOLVE | SNAPSHOT,
  authorAddress: bytes20,
  authorEpoch: u64,
  authorSeq: u64,
  logicalKey: bytes32,
  parents: RecordId[],
  baseHeads: RecordId[],
  policyRef: BlobId,
  payloadRef: BlobId,
  chainBinding: ChainBindingV1 | null,
  nonConsensusTimestampMs: u64 | null,
  signature: bytes65
}
```

Rules:

- `parents` and `baseHeads` are sorted, unique, and collection-scoped.
- `authorSeq` is monotonic within `(view, authorAddress, authorEpoch)` but is not
  a synchronization cursor and does not order different authors.
- `logicalKey` is stable across assertion versions.
- `DELETE` has no application payload except its deterministic deletion
  manifest.
- `RESOLVE` references every conflicting active head.
- `policyRef` must equal the active membership checkpoint's `rdfPolicyRef`.
- `payloadRef` points to `RdfMutationV1`, `MoveTierV1`, or the snapshot manifest
  required by the record type.
- `chainBinding` is required for VM activation records and null otherwise.
- A record is advertisable only after its checkpoint and every referenced blob
  are durable.

### 6.2 RDF logical key

```text
logicalKey = BLAKE3(
  "dkg-rdf-logical-key-v1\0" || deterministicCBOR({
    contextGraphId,
    subGraphName,
    authorAddress,
    knowledgeAssetUal | rootEntity
  })
)
```

Author scope is deliberate. Shared-write keys require a signed policy that
names the allowed writers and conflict resolvers.

### 6.3 `RdfMutationV1`

`payloadRef` for `PUT`, `DELETE`, and `RESOLVE` points to this manifest:

```text
RdfMutationV1 {
  version: 1,
  mode: REPLACE | PATCH | DELETE,
  baseStateDigest: bytes32,
  resultStateDigest: bytes32,
  replaceGraphs: [{ graphIri, nquadsBlobId, quadCount }],
  replaceSubjects: [{ graphIri, subjectIri, nquadsBlobId, quadCount }],
  deleteNQuadsBlobId: BlobId | null,
  insertNQuadsBlobId: BlobId | null,
  touchedKeys: [{ graphIri, subjectIri, predicateIri }],
  sourceSparqlAuditRef: BlobId | null
}
```

- `REPLACE` may replace exact graphs and exact metadata subjects in one logical
  operation. It is the default for graph-scoped KAs.
- `PATCH` contains explicit canonical deletes and inserts. Remote nodes never
  execute the source SPARQL.
- `DELETE` makes the logical key inactive but retains its tombstone.
- The reducer recomputes and verifies touched keys and state digests.
- A concurrent `REPLACE` conflicts with every incomparable mutation of the same
  logical key.

### 6.4 `MoveTierV1`

```text
MoveTierV1 {
  sourceView,
  sourceHeads: RecordId[],
  targetView,
  targetMutationRef: BlobId
}
```

The source SWM state remains in the WAL. The active view marks it superseded only
when VM validation reaches the configured finalized chain frontier.

### 6.5 `ChainBindingV1`

```text
ChainBindingV1 {
  chainId: string,
  contextGraphOnChainId: bytes32,
  kaId: bytes32,
  assertionVersion: u64,
  merkleRoot: bytes32,
  transactionHash: bytes32,
  blockNumber: u64,
  blockHash: bytes32,
  transactionIndex: u32,
  logIndex: u32,
  eventType: PUBLISH | UPDATE,
  requiredFinalityBlocks: u32
}
```

### 6.6 `AuthorCheckpointV1`

```text
AuthorCheckpointV1 {
  version: 1,
  view,
  authorAddress,
  authorEpoch,
  checkpointNumber,
  setTreeVersion: 1,
  recordSetRoot: bytes32,
  recordCount: u64,
  maxAuthorSeq: u64,
  previousCheckpointId: CheckpointId | null,
  baselineSnapshotId: RecordId | null,
  compactionFloor: u64,
  signature
}
```

Protocol version 1 creates one checkpoint in the same local transaction that
finalizes each authored record. This favors simple semantics over signature
batching. A later protocol may batch checkpoints without changing record IDs.

Within one author epoch, every newer checkpoint must be a set extension. History
may be cut only by a new epoch whose first record is an author-signed snapshot.

### 6.7 `MembershipCheckpointV1`

```text
MembershipCheckpointV1 {
  version: 1,
  collection,
  checkpointNumber: u64,
  policyEpoch: u64,
  publishMode: CURATED | OPEN,
  authorAddresses: bytes20[],
  memberAgentAddresses: bytes20[],
  allowedPeerIds: string[],
  activeViews: ReplicationViewKey[],
  rdfPolicyRef: BlobId,
  previousMembershipCheckpointId: MembershipCheckpointId | null,
  issuedAtMs: u64,
  signatureByCurator: bytes65
}
```

Arrays are sorted and unique. Curated views admit records only from listed
authors. Private disclosure requires a listed member agent or a policy-valid
delegation bound to the transport peer. `OPEN` permits a new public author only
when its record carries valid chain authorization; the next head vector must
index that author before the collection can report `complete`.

### 6.8 `CollectionHeadVectorV1`

```text
CollectionHeadVectorV1 {
  version: 1,
  collection,
  membershipCheckpointId,
  expectedViews: [{
    view: ReplicationViewKey,
    authors: [{ authorAddress: bytes20, checkpointId: CheckpointId }]
  }],
  vectorEpoch,
  vectorNumber,
  issuedAtMs,
  expiresAtMs,
  finalizedChainFrontier: { chainId, blockNumber, blockHash } | null,
  signatureByCurator
}
```

`expectedViews` is sorted by canonical view bytes; each author list is sorted by
address and unique.

Defaults:

- curator issues immediately after a valid author-checkpoint nudge or every 5
  seconds, whichever occurs first;
- vector validity is 60 seconds;
- accepted local clock skew is 5 seconds;
- the highest accepted `(epoch, number, hash)` is stored in a rollback guard
  outside graph and WAL snapshot restore domains;
- an expired or rolled-back vector yields `unknown-freshness`;
- private roots are not served under `unknown-freshness`.

For an open public CG, chain-valid authors may create new lanes. Their state is
not reported complete until a newer curator vector includes their checkpoint.
The curator indexes freshness; it does not become the content author.

### 6.9 `NetworkWalCutoverV1`

```text
NetworkWalCutoverV1 {
  version: 1,
  networkId,
  walProtocolVersion: 1,
  rdfAdapterVersion: 1,
  requiredNodeVersion,
  collectionVectorManifestRef: BlobId,
  cutoverEpoch,
  activation: { mode: TIME, notBeforeMs } |
              { mode: BLOCK, chainId, blockNumber, blockHash },
  legacySyncDisabled: true,
  signatureByNetworkAuthority
}
```

`collectionVectorManifestRef` identifies deterministic CBOR containing the
sorted complete list of `{ collection, vectorId }` entries covered by the
cutover. Every node must start WAL-authoritative mode with the same `CutoverId`.
Mixed legacy/WAL authority is rejected.

## 7. Blob format and resumable transfer

Protocol version 1 uses a simple BLAKE3 Merkle tree rather than depending on a
specific Bao library.

- fixed chunk size: 65,536 bytes;
- final chunk may be shorter;
- a zero-length blob is represented by one empty chunk at index zero;
- no compression;
- whole transfer for blobs no larger than one chunk;
- range requests are chunk-aligned;
- one response carries at most 16 chunks, about 1 MiB.

```text
leafHash = BLAKE3(
  "dkg-wal-blob-leaf-v1\0" ||
  u64be(chunkIndex) || u64be(blobLength) || chunkBytes
)

padHash = BLAKE3(
  "dkg-wal-blob-pad-v1\0" ||
  u64be(chunkIndex) || u64be(blobLength)
)

nodeHash = BLAKE3("dkg-wal-blob-node-v1\0" || leftHash || rightHash)
```

Leaves are padded to the next power of two using `padHash`. A range proof
contains the returned chunks and the minimal ordered sibling hashes needed to
reconstruct the root.

```text
BlobId = BLAKE3(
  "dkg-wal-blob-id-v1\0" ||
  u64be(blobLength) || u32be(65536) || blobTreeRoot
)
```

A receiver writes verified chunks into a sparse `.part` file and stores a chunk
bitmap in SQLite. After all chunks arrive it recomputes the root, fsyncs the
file, atomically renames it to the final hash path, fsyncs the parent directory,
and marks the blob complete. Different chunks may come from different
authorized providers.

## 8. Deterministic set tree

Each author checkpoint commits one set of `RecordId` values using a 16-way radix
trie over the 64 nibbles of the 32-byte ID.

- leaf capacity: 256 IDs;
- IDs inside a leaf are sorted and unique;
- a leaf that exceeds capacity splits by the next nibble;
- maximum depth: 64;
- an internal response contains at most 16 child summaries;
- a leaf response returns the complete leaf, never a selected subset.

```text
leafHash = BLAKE3(
  "dkg-wal-set-leaf-v1\0" ||
  u8(prefixNibbleLength) || packedPrefix || u64be(count) || concat(sortedIds)
)

branchHash = BLAKE3(
  "dkg-wal-set-branch-v1\0" ||
  u8(prefixNibbleLength) || packedPrefix || u16be(childBitmap) ||
  concat(u8(nibble), u64be(childCount), childHash in nibble order)
)
```

Reconciliation compares `(recordCount, recordSetRoot)`, descends only into
mismatching prefixes, verifies every returned leaf and root path, computes the
missing IDs, and then fetches records. There is no IBLT accelerator in version
1.

## 9. Transport protocol

Version 1 uses the existing raw libp2p `ProtocolRouter`, not the reliable-message
outbox. All control messages are deterministic CBOR frames with an unsigned
varint length prefix and a 1 MiB maximum frame.

```text
/dkg/10.1.0/wal-head
/dkg/10.1.0/wal-reconcile
/dkg/10.1.0/wal-record
/dkg/10.1.0/wal-blob
```

### Iroh-inspired transport properties

Protocol version 1 does not depend on the Iroh runtime, but deliberately adopts
the following design properties from Iroh's content and connectivity model:

- stable cryptographic peer identity and authenticated encrypted transport;
- content identity independent of the peer or path serving it;
- metadata reconciliation separated from bulk byte transfer;
- resumable, incrementally verified byte ranges;
- provider switching without changing object identity or correctness;
- direct paths when available and relay paths as an availability mechanism;
- live discovery or gossip as hints, never the durable completeness proof.

The existing libp2p router supplies the version-1 byte streams. A future Iroh
endpoint or another transport may implement the same framed protocols if it
preserves identity binding, authorization-before-disclosure, limits, and exact
byte/proof semantics. Iroh does not supply DKG membership, curator freshness,
WAL admission, RDF conflict handling, VM chain validation, or private key
policy; those remain protocol and adapter responsibilities defined here.

### Requests

Every request binds:

- `requestId` of 16 random bytes;
- `issuedAtMs` with a 90-second maximum age;
- requester and target peer IDs;
- exact replication view;
- optional requester agent and identity proof;
- the current private-view membership proof when required.

Private authorization reuses the existing agent, delegation, and membership
rules. Replay IDs are cached for the request freshness window. Authorization is
performed before returning a head vector, checkpoint, set node, ID, size, or
blob byte.

### Message families

| Protocol | Request | Response |
|---|---|---|
| `wal-head` | `GET_VECTOR`, `GET_CHECKPOINT` | Signed vector/checkpoint or denied. |
| `wal-reconcile` | `GET_NODE`, `GET_LEAF` | Authenticated node summary or complete leaf proof. |
| `wal-record` | `GET_RECORDS` up to 128 IDs | Canonical record frames, each no larger than 64 KiB. |
| `wal-blob` | `GET_BLOB_INFO`, `GET_CHUNKS` | Length/root or up to 16 chunks plus proof. |

Responses echo `requestId`. A provider may be switched at any request boundary
because correctness is verified by signed roots and content IDs, not by provider
session state.

## 10. Durable storage implementation

### 10.1 SQLite

Use a dedicated SQLite database with:

```text
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
```

Minimum tables:

| Table | Purpose |
|---|---|
| `records` | Canonical signed bytes and decoded index fields. |
| `blobs` | Blob metadata, path, root, length, completion state. |
| `blob_chunks` | Partial-download bitmap and verified chunk state. |
| `author_lanes` | Next sequence, checkpoint number, current set root/count. |
| `set_nodes` | Persistent radix-tree nodes. |
| `checkpoints` | Canonical signed author checkpoints. |
| `vectors` | Verified curator vectors and current expected heads. |
| `idempotency` | `(view, author, key) -> requestDigest, RecordId, status`. |
| `admission` | Proof, closure, validation, quarantine, and reason state. |
| `materialization` | Per-logical-key desired and applied head/state digests. |
| `peer_state` | Provider success, failures, backoff, and availability hints. |

The rollback-resistant vector high-water is stored in a separate small SQLite
file excluded from WAL, graph, and snapshot restores.

### 10.2 Local write transaction

1. Compile the request to canonical mutation and policy-bound metadata.
2. Write and fsync every referenced blob.
3. Acquire the per-author lane mutex.
4. Begin `IMMEDIATE` SQLite transaction.
5. Resolve the idempotency key. A repeated key with another request digest is an
   error; the same digest returns the existing record.
6. Allocate `authorSeq`.
7. Build and sign the canonical record.
8. Insert the record and update the persistent set tree.
9. Build and sign the new author checkpoint.
10. Update the author lane and idempotency mapping.
11. Commit.
12. Materialize the logical key synchronously or return
    `materialization-pending` with the durable `RecordId`.
13. Send a best-effort checkpoint nudge.

The SQLite transaction remains open while signing. No network or graph call may
occur inside it.

```mermaid
sequenceDiagram
    participant C as Client/API
    participant R as RDF compiler
    participant B as BlobStore
    participant W as WalStore + signer
    participant M as RDF materializer
    participant G as Graph store
    participant H as Curator/head service

    C->>R: Mutation and idempotency key
    R->>G: Read bounded logical-key base
    G-->>R: Base heads and canonical state
    R->>R: Compile explicit mutation and verify policy
    R->>B: Persist all referenced blobs
    B-->>R: Durable BlobIds
    R->>W: Commit canonical request
    W->>W: Lock author lane and begin IMMEDIATE
    W->>W: Resolve idempotency, allocate sequence, sign record
    W->>W: Insert record, set-tree node, and signed checkpoint
    W->>W: Commit SQLite transaction
    W->>M: Queue affected logical key
    M->>G: applyWalProjectionAtomic(...)
    G-->>M: APPLIED or GUARD_FAILED
    M-->>W: Materialization status
    W-->>C: RecordId and materialization status
    W-->>H: Best-effort checkpoint nudge
```

### 10.3 Remote admission transaction

A fetched record remains staged until:

- checkpoint signature and set inclusion are verified;
- record bytes, ID, author signature, policy, and view are valid;
- all referenced blobs are complete;
- ordinary parents and base heads are available;
- cross-author references are allowed by policy and available in the expected
  vector closure;
- private ciphertext authenticates and decrypts for an authorized local member;
- configured limits are satisfied.

The admission transaction inserts the closed record set and queues affected
logical keys. Invalid records are retained only in bounded quarantine storage
with a stable reason code.

## 11. RDF canonicalization and compiler

### 11.1 Canonical N-Quads

- UTF-8 with LF line endings;
- one quad per line;
- absolute IRIs only for subject, predicate, and graph;
- blank nodes are rejected; DKG skolem IRIs are required;
- RDF 1.1 N-Quads escaping;
- language tags lowercase;
- duplicate quads removed;
- full lines sorted by unsigned UTF-8 byte order.

```text
stateDigest = BLAKE3(
  "dkg-rdf-state-v1\0" || concat(canonicalSortedNQuads)
)
```

### 11.2 Accepted local SPARQL subset

The local API may accept:

- `INSERT DATA`;
- `DELETE DATA`;
- bounded `DELETE/INSERT WHERE` scoped to one declared logical key and exact
  adapter-owned graphs.

The compiler rejects:

- `SERVICE`, `LOAD`, `CLEAR ALL`, `DROP ALL`, `COPY`, `MOVE`, and `ADD`;
- time, randomness, UUID, or implementation-specific functions;
- graph variables that can escape the declared logical key;
- reads from unrelated local graphs;
- mutations whose explicit result exceeds policy limits.

The compiler evaluates the accepted operation once against the declared base
heads and emits `RdfMutationV1`. Only explicit canonical result bytes are
replicated. Every production write path must compile successfully before
cutover.

## 12. Signed RDF policy

`policyRef` points to a content-addressed `RdfPolicyV1` that is admitted by the
current signed membership checkpoint.

```text
RdfPolicyV1 {
  version: 1,
  adapterVersion: 1,
  allowedGraphPrefixes,
  maxQuadsPerMutation,
  maxBlobBytes,
  singleValuedPredicates,
  multiValuedPredicates,
  sharedWriteLogicalKeys,
  resolverAddresses,
  expiryAuthorityAddresses,
  allowedRecordTypes
}
```

Default conflict policy is conservative:

- causal successor: apply;
- exact replay: idempotent;
- concurrent `REPLACE`: conflict;
- concurrent `PATCH`: merge only when touched keys are disjoint;
- different objects for one predicate merge only when policy declares the
  predicate multi-valued;
- delete-versus-update, failed precondition, incompatible tier movement, or
  chain disagreement: conflict.

General SHACL execution is not consensus logic in version 1. A future policy
version may define a deterministic SHACL subset.

## 13. Reducer and conflicts

For each logical key, the reducer builds the causal DAG from admitted records.
`RecordId` is only a deterministic processing tie-break, never a winner rule.

1. Find maximal causally accepted heads.
2. Apply compatible successors and approved merges.
3. If incompatible heads exist, compute their maximal common accepted causal
   base.
4. Make only that common base active.
5. Store each incompatible branch in a reserved conflict graph.
6. Expose conflict metadata through API and system graph.
7. Accept a `RESOLVE` only when its authorized signer references every current
   conflict head and provides the complete resulting mutation.

Reserved graphs:

```text
urn:dkg:wal:projection
urn:dkg:wal:conflicts:<collection-hash>
urn:dkg:wal:conflict:<record-id>
```

Same-sequence author equivocation is retained, marks the author lane blocked,
and prevents new ambiguous state from becoming active until the curator rotates
the author epoch or an authorized governance resolution is admitted.

```mermaid
sequenceDiagram
    participant A as Author A
    participant B as Author B
    participant W as WAL admission
    participant R as Deterministic reducer
    participant G as Graph projection
    participant X as Authorized resolver

    par Concurrent mutations from the same causal base
        A->>W: Signed PUT/PATCH A
        B->>W: Signed PUT/PATCH B
    end
    W->>W: Verify signatures, policy, blobs, and causal closure
    W->>R: Admitted record set, independent of arrival order
    R->>R: Build causal DAG and classify compatibility
    alt Mutations are compatible under signed policy
        R->>G: Atomically materialize deterministic merge
    else Mutations are incompatible
        R->>G: Keep maximal common base active
        R->>G: Materialize both reserved conflict branches
        G-->>X: Expose heads and conflict metadata
        X->>W: Signed RESOLVE referencing every current head
        W->>R: Admit resolution and re-evaluate DAG
        R->>G: Atomically activate resolved state
    end
```

## 14. Atomic materialization

WAL and graph do not share a distributed transaction. Only the graph projection
operation itself must be atomic.

Each logical key has a marker in `urn:dkg:wal:projection` containing:

- adapter version;
- active-head-set digest;
- projected state digest;
- source vector ID;
- materialization status.

The storage package exposes one required capability:

```text
applyWalProjectionAtomic({
  logicalKey,
  expectedHeadDigest,
  replaceGraphs,
  replaceSubjects,
  deleteQuads,
  insertQuads,
  conflictGraphs,
  newHeadDigest,
  newStateDigest,
  vectorId
}) -> APPLIED | GUARD_FAILED
```

The backend must commit content, conflict graphs, and marker all-or-none. A lost
response is resolved by reading the marker. `GUARD_FAILED` causes reducer
recalculation and retry. Content/marker disagreement blocks readiness and forces
rebuild of that logical key.

Initial authoritative support is limited to backends that pass fault-injection
atomicity tests. Oxigraph is the reference implementation. Blazegraph becomes
eligible only after the same tests pass. A backend without this capability may
run the parallel protocol but cannot participate after cutover.

## 15. Private payloads

Reuse the existing Sender Key membership and key-package distribution. For each
private view and key epoch:

```text
recordKey = HKDF-SHA256(
  epochKey,
  salt = authorAddress || u64be(authorEpoch),
  info = "dkg-wal-private-record-v1\0" ||
         u64be(authorSeq) || logicalKey
)
```

Payload bytes use AES-256-GCM with a random 12-byte nonce. The WAL store enforces
nonce uniqueness per derived key. Associated data commits to collection, view,
author, sequence, logical key, type, parents, base heads, policy, codec, media
type, key epoch, and nonce. The signed record separately commits to ciphertext
`BlobId`, root, and length.

Ciphertext, including the authentication tag, is the content-addressed blob.
Plaintext hashes are not advertised. Member removal rotates the key epoch and
stops future serving. It cannot revoke ciphertext or keys previously obtained.

## 16. VM activation and reorgs

A VM record may be admitted before it is active. Activation requires the
current chain adapter to verify:

- UAL/KA identity and author;
- context-graph binding;
- Merkle root;
- assertion version/root count;
- publish or update receipt and event location;
- block hash and configured finality depth.

The materializer stores the verified chain frontier with the projection marker.
A chain watcher periodically rechecks stored block hashes. On reorg or loss of
finality, the VM branch returns to `pending`, and the reducer restores the last
valid SWM head when one exists. WAL history is never deleted by a reorg.

```mermaid
sequenceDiagram
    participant P as Publisher/author
    participant C as Chain
    participant W as WAL
    participant V as VM chain validator
    participant R as Reducer/materializer
    participant G as SWM/VM projection

    P->>C: Publish or update KA commitment
    C-->>P: Receipt, event location, block hash
    P->>W: Signed VM activation/MOVE_TIER record
    W->>V: Validate ChainBindingV1 and current policy
    V->>C: Verify identity, root, receipt, block, and finality
    alt Not final or evidence invalid
        V-->>W: pending or rejected with reason
        W->>R: Keep last valid SWM head active
    else Finalized and valid
        V-->>W: Verified chain frontier
        W->>R: Admit VM activation
        R->>G: Atomically activate VM and supersede SWM view
    end
    loop Recheck stored finalized frontier
        V->>C: Verify canonical block hash
        alt Reorg or finality lost
            V->>R: Return VM branch to pending
            R->>G: Restore last valid SWM head if present
        end
    end
```

## 17. Deletion, expiry, snapshots, and compaction

### Deletion and expiry

- Deletion is a signed `DELETE` with causal `baseHeads`.
- Expiry is a `DELETE` signed by the owner or policy-designated expiry authority
  and bound to a signed curator vector number or finalized chain block.
- Local wall time may schedule the expiry request but may not independently hide
  state.
- Tombstones remain part of the author set or its signed snapshot baseline.

### Snapshot

An author-signed `SNAPSHOT` contains a manifest of that author's lane state. It
may reference other authors' records when preserving a shared-key conflict, but
it cannot replace their checkpoints or attest to their authorship. The manifest
contains:

- every live logical key and active head contributed by that author;
- canonical state digest and graph blob IDs;
- unresolved conflicts touching those heads;
- covered checkpoint and set root;
- policy, adapter version, and VM chain frontier.

Default snapshot trigger is 100,000 authored records or 30 days, whichever
comes first. The thresholds are configurable but are signed into network policy.

### Compaction

Compaction starts a new author epoch whose first record is the snapshot.
Ordinary serving of pre-snapshot records may stop only after:

- the snapshot and all blobs exist on the author and two additional authorized
  custodians;
- a valid curator vector references the new epoch checkpoint;
- a 30-day retention grace has elapsed.

A peer below `compactionFloor` must install and verify the snapshot before
reconciling post-snapshot records. Tombstones and conflicts are represented in
the snapshot, preventing resurrection.

### Genesis

Entering parallel mode begins with one maintenance barrier:

1. pause writes for each collection;
2. enumerate only known SWM/VM graph families;
3. canonicalize current accepted state;
4. create author-signed genesis snapshots when provenance is provable;
5. place unclaimable legacy state in a read-only `LegacyGenesisV1` lane signed
   by the network migration authority, without pretending it has an original
   author signature; this lane is quarantined from the active projection unless
   an explicit signed migration policy authorizes its visibility;
6. sign genesis checkpoints and a curator head vector;
7. resume legacy production and shadow WAL capture.

All changes after this barrier must produce WAL records in parallel mode.

### Backfill and projection rebuild

The protocol supports state backfill, not fabrication of pre-WAL event history.
An empty, stale, or rebuilt node converges on current authenticated SWM/VM state
using one of these paths:

1. **Incremental catch-up:** when every local author checkpoint is at or above
   its compaction floor, reconcile missing record IDs and blob chunks directly.
2. **Snapshot plus delta:** when an author lane is absent or below its floor,
   install that author's verified baseline snapshot and then reconcile all
   post-baseline records named by the current head vector.
3. **Genesis bootstrap:** when joining the parallel deployment, install the
   authenticated genesis snapshots and permitted legacy lanes, then reconcile
   every record after the genesis barrier.
4. **Projection rebuild:** when verified WAL bytes are locally complete but RDF
   is missing or corrupt, discard or isolate the projection and replay the
   baseline plus accepted records through the pinned adapter version. Network
   transfer is needed only for bytes that fail local verification.

```mermaid
sequenceDiagram
    participant R as Receiving node
    participant P as Authorized provider
    participant W as WAL verifier/store
    participant A as RDF reducer/materializer
    participant G as SWM/VM projection

    R->>P: GET_VECTOR with authorization evidence
    P->>P: Authorize before disclosing metadata
    P-->>R: Signed membership, vector, and checkpoints
    R->>W: Verify freshness, signatures, roots, and rollback guard
    alt Lane absent or below compaction floor
        R->>P: Fetch author snapshot and verified blob chunks
        P-->>R: Snapshot record, manifest, bytes, and proofs
        R->>W: Verify and install baseline into staging
    else Retained baseline is usable
        R->>W: Keep verified local baseline
    end
    loop Each mismatching author checkpoint
        R->>P: GET_NODE / GET_LEAF for mismatching prefixes
        P-->>R: Authenticated set-tree proofs and missing IDs
        R->>P: GET_RECORDS and GET_CHUNKS
        P-->>R: Canonical records and resumable blob ranges
        R->>W: Verify closed batch and durably admit
    end
    W->>A: Replay affected causal DAGs
    A->>G: Atomic current state, tombstones, and conflicts
    G-->>R: Projection marker reaches target VectorId
```

Backfill uses the same private-view authorization, encryption-epoch, policy,
VM-chain, conflict, and resource checks as live synchronization. Legacy data
whose provenance is neither author-verifiable nor migration-policy-authorized
remains quarantined. The completeness guarantee is the authenticated baseline
plus every WAL record named after it; complete mutation history before that
baseline is outside the protocol guarantee.

## 18. Parallel protocol and hard cutover

### 18.1 Parallel mode

`sync.mode = parallel` means:

- current graph sync and graph writes remain production-authoritative;
- every local eligible mutation also commits to the shadow WAL;
- the WAL protocols operate between all upgraded nodes;
- WAL records materialize into an isolated shadow store or shadow graph
  namespace;
- production queries never read shadow state;
- legacy sync results are not converted into synthetic WAL history;
- every active author must be upgraded and produce WAL records before cutover.

This is a complete parallel protocol, not a partial canary authority model.

### 18.2 Cutover gates

Cutover is allowed only when all conditions hold for every collection:

- every measurable success criterion in Section 1 has a reproducible evidence
  bundle containing workload inputs, environment, raw measurements, and digests;
- every active node and author supports the required node, protocol, and adapter
  versions;
- current vectors are valid and no collection reports `unknown-freshness`;
- all expected author set roots and counts match across the fleet;
- all blobs are complete;
- shadow materialization has no lag;
- production and shadow canonical RDF state digests match;
- conflict digests match the expected reducer result;
- every current write path compiles to WAL;
- full rebuild from genesis/snapshot plus records reproduces the shadow digest;
- crash, range-resume, provider-switch, private-auth, equivocation, deletion,
  expiry, VM-finality, and reorg tests pass;
- resource and throughput targets pass at production scale.

### 18.3 Network-wide switch

1. Announce a maintenance window and stop all writes.
2. Disable legacy gossip and sync initiation, then drain in-flight operations.
3. Finalize one author checkpoint per lane.
4. Issue final curator vectors and reconcile every node to them.
5. Verify production/shadow parity and zero materialization lag.
6. Sign `NetworkWalCutoverV1`.
7. Restart all nodes with `sync.mode = wal` and the exact `CutoverId`.
8. Promote the verified shadow projection or rebuild production from WAL.
9. Do not register legacy sync protocols or allow legacy graph writers.
10. Resume writes.

There is no live fallback. Before writes resume, the fleet may abort and return
to legacy mode. After WAL writes resume, rollback requires another maintenance
window and deterministic graph export from WAL; it is not an automatic protocol
fallback.

```mermaid
sequenceDiagram
    participant O as Network operator
    participant L as Legacy authority
    participant N as Upgraded fleet
    participant C as Curator/network authority
    participant W as WAL authority

    O->>L: Begin maintenance window and stop writes
    O->>L: Disable initiation and drain legacy sync
    O->>N: Finalize every author checkpoint
    N->>C: Submit final checkpoint nudges
    C-->>N: Final membership and head vectors
    N->>N: Reconcile records/blobs and verify zero lag
    N-->>O: Fleet-wide production/shadow parity evidence
    alt Any gate fails before activation
        O->>L: Abort maintenance and restore legacy mode
    else Every gate passes
        C->>C: Sign NetworkWalCutoverV1
        C-->>N: One CutoverId and activation frontier
        O->>N: Restart with sync.mode=wal and exact CutoverId
        N->>W: Promote or rebuild verified projection
        N->>N: Reject legacy protocols and graph writers
        O->>W: Resume writes under WAL authority
    end
```

## 19. Implementation layout

Recommended modules:

```text
packages/wal/
  src/canonical-cbor.ts
  src/ids.ts
  src/record.ts
  src/checkpoint.ts
  src/vector.ts
  src/cutover.ts
  src/wal-store.ts
  src/blob-store.ts
  src/blob-tree.ts
  src/set-index.ts
  src/set-proof.ts
  src/authority.ts
  src/reconcile.ts
  src/protocol/*.ts

packages/agent/src/wal/
  local-commit.ts
  remote-admission.ts
  reconciliation-worker.ts
  provider-selection.ts
  status.ts

packages/storage/src/wal/
  rdf-canonical.ts
  sparql-compiler.ts
  rdf-reducer.ts
  materializer.ts
  oxigraph-materializer.ts
  conflict-projection.ts

packages/publisher/src/
  existing publish/share paths call local-commit.ts

packages/cli/src/daemon/routes/
  wal-status.ts
  wal-conflicts.ts
  wal-records.ts
  wal-admin.ts
```

### Concurrency

- one mutex per local author lane for sequence/checkpoint finalization;
- one mutex per logical key for reduction/materialization;
- maximum four reconciliation streams per peer;
- maximum two blob streams per collection and peer;
- global materialization queue with policy-priority scheduling;
- all queues persist retry state in SQLite.

### Default limits

| Limit | Default |
|---|---:|
| Control frame | 1 MiB |
| Canonical record | 64 KiB |
| IDs per record request | 128 |
| Set leaf | 256 IDs |
| Blob chunk | 64 KiB |
| Chunks per response | 16 |
| Blob size | 1 GiB configurable, 8 GiB hard cap |
| Quads per mutation | 1,000,000 policy cap |
| Conflict heads per logical key | 32 |
| Quarantined bytes per peer | 256 MiB |
| Request freshness | 90 seconds |
| Curator vector validity | 60 seconds |
| Clock skew | 5 seconds |

Exceeding a hard limit rejects or quarantines the object. It never partially
materializes it.

## 20. API and readiness

Publish/share responses include:

```text
recordId
walStatus: committed | already-committed
materializationStatus: materialized | pending | blocked
checkpointId
```

A materialization failure after WAL commit returns the durable `RecordId` and
`pending`, not an ambiguous generic failure. Retrying with the same idempotency
key returns the same record.

Required operator endpoints:

- WAL/vector/checkpoint status per collection and author;
- missing records and blob chunks;
- projection lag and state digest;
- active/conflicting/quarantined logical keys;
- author equivocation;
- provider and retry state;
- force reconcile and rebuild;
- signed conflict resolution submission.

Readiness states are exactly:

```text
complete
known-incomplete
unknown-freshness
materialization-lag
blocked
```

Production readiness requires `complete` for every required view.

## 21. Acceptance tests

The implementation is not cutover-eligible until it proves:

- same admitted set produces the same active and conflict digests on every node;
- opposite arrival order produces identical state;
- a malicious provider cannot omit IDs from a mismatching leaf;
- interrupted blob transfer resumes without retransmitting verified chunks;
- switching providers during a transfer preserves correctness;
- no incomplete record/blob set mutates canonical RDF state;
- crashes at every blob, SQLite, checkpoint, admission, and materialization
  boundary recover automatically;
- tombstones survive stale-peer reconnect and compaction;
- private callers cannot obtain roots, IDs, lengths, or bytes without current
  authorization;
- removed members cannot access new key epochs;
- same-sequence author equivocation is detected and blocked;
- VM activation and reorg behavior match chain truth;
- an empty node reaches the current vector through snapshot-plus-delta backfill;
- a node below a compaction floor cannot resurrect deleted or expired state;
- a locally complete WAL rebuilds a missing projection without graph sync;
- full rebuild reproduces the exact projection digest;
- steady-state reconciliation performs no graph enumeration;
- parallel production/shadow parity holds for the complete fleet before the
  single cutover;
- a node with a missing or mismatched `CutoverId` cannot enter authoritative
  mode, and no legacy protocol or graph writer is accepted after activation.

## 22. Implementation-freeze checklist

The architecture and version-1 direction are fixed, but the document is not a
byte-for-byte interoperable implementation specification until the following
items are resolved and backed by conformance vectors:

1. **Signed payload descriptor.** `WalRecordV1` currently names `payloadRef`,
   while private AEAD associated data also requires byte length, codec, media
   type, algorithm, key epoch, and nonce. Define one canonical signed
   `PayloadDescriptorV1`; the nonce and all decryption-critical metadata must
   not arrive as unsigned side information.
2. **Snapshot wire schema and closure.** Define canonical `SnapshotManifestV1`,
   `LegacyGenesisV1`, and custody-receipt schemas; specify snapshot-record
   `parents`/`baseHeads`; and prove that a post-compaction receiver can validate
   causal closure without fetching records below the floor. “Exists on two
   custodians” requires signed, expiring availability evidence and a policy for
   custodian removal.
3. **Set-tree and blob conformance vectors.** Fix the empty-set root, odd-nibble
   prefix packing, proof framing, malformed-proof rejection, duplicate handling,
   and exact roots for zero-, one-, split-, and padded-leaf examples. Publish
   canonical CBOR, signature, object-ID, blob-proof, and set-proof test vectors.
4. **Reducer conformance.** Normatively relate `parents`, `baseHeads`,
   `baseStateDigest`, and `touchedKeys`; define multi-base common-state
   calculation; and publish fixtures for concurrent patches, replace/patch,
   delete/update, tier movement, and resolution. Prose alone is insufficient
   for cross-implementation convergence.
5. **Cross-view privacy for `MOVE_TIER`.** A public VM object must not expose
   private SWM record IDs, graph names, epochs, or activity counts. Replace the
   current direct `sourceHeads` reference with a two-sided transition or an
   opaque commitment whose private opening is served only in the source view.
6. **Authority lifecycle and availability.** Specify curator and network-key
   rotation, vector-epoch transitions, emergency revocation, multi-signer or HA
   operation, and recovery when the rollback high-water file is lost. The
   60-second vector validity otherwise makes curator availability a fleet-wide
   readiness dependency.
7. **Provider discovery and cold start.** Define how an empty node obtains at
   least one authorized provider and the current membership/vector without
   trusting gossip, including private collections whose metadata cannot be
   publicly advertised.
8. **Cutover cohort and late nodes.** Define “every active node and author,” the
   treatment of offline/decommissioned identities, authenticated distribution
   and persistence of `CutoverId`, and the mandatory bootstrap path for a node
   that returns after legacy protocols are disabled.
9. **Complete resource bounds.** Add fixed maxima and pagination rules for
   parents, base heads, touched keys, graphs, authors per vector, active views,
   causal-closure depth, snapshot entries, outstanding requests, and quarantine
   retention time. The general bounded-resource invariant is not enough for
   interoperable rejection behavior.
10. **VM finality policy.** `requiredFinalityBlocks` in an author-signed record
    must not let the author weaken network finality. Specify that activation uses
    the current chain/network policy, with a signed record value serving at most
    as a stricter request, and define policy behavior across reconfiguration.

Closing these items should not change the replicated-bytes architecture. It
will turn the proposal from an implementation blueprint into a normative wire
and convergence specification.

## 23. Fixed version-1 decisions

| Area | Decision |
|---|---|
| Control codec | RFC 8949 deterministic CBOR profile above. |
| Signature | Current secp256k1/EIP-191 agent and curator authority, canonical low-S signature. |
| Hash | BLAKE3 with explicit domains. |
| Blob proof | Fixed 64 KiB BLAKE3 Merkle chunks and range proofs. |
| Set reconciliation | Deterministic 16-way radix tree, leaf 256, no IBLT. |
| Transport | Existing raw libp2p router with four new protocol IDs. |
| Private crypto | Existing Sender Key distribution plus HKDF-SHA256 and AES-256-GCM blobs. |
| RDF format | Canonical, sorted, blank-node-free N-Quads. |
| SPARQL | Local bounded compiler; no remote SPARQL execution. |
| Merge policy | Conservative; replacements conflict, patches merge only when proven compatible. |
| Materialization | Required atomic backend capability; Oxigraph first. |
| Freshness | Curator vector every 5 seconds, valid 60 seconds, 5-second skew. |
| Checkpoints | One signed author checkpoint per authored record transaction. |
| Rollout | Full parallel shadow protocol, then one network-wide hard cutover. |
| Legacy fallback | None after cutover. |

## 24. References

- [Iroh — content-addressed connectivity and transfer](https://github.com/n0-computer/iroh)
- [OT-RFC-64 / OriginTrail dkgv10-spec PR #144](https://github.com/OriginTrail/dkgv10-spec/pull/144)
- [Separate comparison with OT-RFC-64 / PR #144](OT-RFC-65-comparison-with-OT-RFC-64.md)
- [RFC 8949 — Concise Binary Object Representation](https://www.rfc-editor.org/rfc/rfc8949)
- [RFC 2119 — Requirement Levels](https://www.rfc-editor.org/rfc/rfc2119)
