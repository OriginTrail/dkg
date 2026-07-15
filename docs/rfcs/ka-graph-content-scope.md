# KA-scoped RDF sets: remove root entities from control-plane identity

Status: accepted implementation draft

Target: DKG v10 coordinated rootless-KA cutover

Chain change: none expected; V10 leaves remain hashes of canonical `(s,p,o)` terms

## Decision

A Knowledge Asset is the canonical RDF triple set submitted for one KA
assertion. The KA is identified by its UAL plus assertion version and stored in
one exact per-KA named graph in each memory layer.

RDF subjects inside that set are data. They are not storage partitions,
ownership keys, protocol manifest entries, seal members, or lifecycle identity.

For a v2 KA:

```text
KA content identity = (canonical UAL, one-based assertion version)
KA content          = canonical set of RDF triples
local location      = UAL -> exact current layer graph pointer
integrity           = Merkle root + leaf/triple counts
```

The physical graph IRI is never accepted from a remote peer. Each node derives
it from the validated `(contextGraphId, layer, UAL author, UAL number,
subGraphName)` tuple.

## Why the current root list must go

The current implementation derives one `rootEntity` for every top-level named
subject and repeats that list across the seal, lifecycle metadata, share
operation, per-root public snapshot records, ownership metadata, private
storage, finalization messages, and proof reconstruction.

That creates work proportional to entity count rather than content size. A
1,000-triple assertion containing 1,000 subjects currently causes at least
about 13,000 root-linked RDF metadata rows, one manifest entry and snapshot per
subject, repeated root-filter scans, and many sequential store mutations. The
Merkle tree already commits to the triple set, so none of that repetition adds
content integrity.

Root scoping also conflates RDF identity with storage ownership. Two independent
KAs must be allowed to state facts about the same subject without overwriting
or "owning" each other's content. Per-KA graphs provide that isolation directly.

## Invariants

1. One create/finalize request produces one KA containing exactly the canonical
   submitted RDF set.
2. All WM, SWM, VM, replica, sync, and proof paths preserve the same KA graph
   boundary.
3. The Merkle leaf set remains graph-name-independent and contains the same
   canonical `(s,p,o)` terms plus the KA-level private commitment, when present.
4. Blank nodes are deterministically canonicalized/skolemized at KA scope. No
   grouping by a privileged RDF subject is required.
5. Share, sync, publish, update, discard, and ownership operate on a whole KA.
   A selected subset is a new KA (or an explicit whole-assertion replacement),
   never a partial hidden state under the original UAL.
6. A new-path writer emits no root membership metadata. Entity discovery is a
   derived query over the KA graph when an application needs it.
7. Store and network reads are paged before response materialization. A memory
   budget checked only after `JSON.parse` is not a bound.

## Cutover and legacy-read boundary

There is one active write model. Existing V10 root-scoped KAs are retained only
for query/export through a quarantined read adapter:

```ts
type KnowledgeAssetReadScope =
  | {
      version: 1;
      kind: 'legacy-roots';
      access: 'read-only';
      rootEntities: string[];
    }
  | {
      version: 2;
      kind: 'ka-graph';
      access: 'read-write';
      ual: string;
      assertionVersion: string;
      chainId: string;
      agentAddress: string;
      kaNumber: string;
    };

type KnowledgeAssetWriteScope = Extract<
  KnowledgeAssetReadScope,
  { kind: 'ka-graph' }
>;
```

- Missing/zero/one persisted version means a legacy root-scoped read.
- Version two requires a deterministic UAL and positive assertion version. Any
  root list on the same envelope is ignored and never persisted.
- Unknown versions fail closed.
- Create, share, finalize, publish, update, sync-write, replica-write, private
  access mutation, and proof materialization accept only `ka-graph`.
- Attempting to mutate a legacy scope fails with `LEGACY_KA_READ_ONLY`.
- The legacy adapter may read already-materialized root data. It does not emit
  legacy gossip, reconstruct legacy data on a fresh peer, or migrate on write.

The fleet upgrade is coordinated. New write protocols/topics use a bumped
capability so an old node cannot silently decode a v2 message while ignoring its
scope fields. Rolling mixed-fleet mutation is unsupported; old nodes must leave
the active CG before v2 writers are enabled.

## V2 wire shape

The new protocol messages carry:

- `contentScopeVersion = 2`
- canonical `kaUal` where the message does not already carry a UAL
- one-based `assertionVersion`
- one KA-level public triple/leaf count
- zero or one KA-level private Merkle commitment and private triple count

For v2, the legacy repeated `manifest`, `rootEntities`, and per-root private
commitment fields are empty. Receivers reject a v2 message if any is populated,
or if UAL identity conflicts with an existing `agentAddress`/`kaNumber` field.

The v2 publish/storage-ACK protocol hashes and signs the same content and chain
parameters as today. Root lists are not part of the on-chain commitment and do
not require a contract redeploy.

## Storage model

Every replica stores public content in the exact graph derived from the KA
identity:

```text
did:dkg:context-graph:{cg}[/{sub}]/{_working_memory|_shared_memory|_verifiable_memory}/{author}/{number}
```

The lifecycle/UAL record carries the current `assertionGraph` pointer. CG-wide
queries obtain a bounded list of admitted per-KA graphs from `_meta` and execute
with `VALUES ?g { ... } GRAPH ?g { ... }`. New v2 content is never flattened as
its only canonical copy into a shared CG data graph.

One share operation writes one operation record and, when needed, one snapshot
digest over the complete public KA set. Operation-level publisher, timestamp,
context graph, and attribution fields are written once.

`workspaceOwner` is unnecessary for v2. The UAL author and per-KA graph identity
provide isolation; CG authorization determines who may introduce/share a KA.

## Private content

Private content is keyed by `(UAL, assertion version)` and committed as one
KA-level private Merkle root. It may be chunked for transport or storage, but
chunk identity is an implementation detail and never an RDF subject.

An authorized entity-level request may query/filter the private KA after access
is granted. That application query does not turn the subject into storage or
protocol identity.

Existing legacy private bags may be exported by their current owner through the
read-only adapter; they cannot be rekeyed or mutated in place.

## Proofs and validation

V2 validation checks that:

- the payload parses as safe canonical RDF;
- blank nodes have been deterministically canonicalized;
- reserved/system predicates are not user-authored;
- the complete set's leaf count and Merkle root match the claimed commitment;
- the UAL/author/KA-number identity is internally consistent.

Random-sampling proof reconstruction resolves the UAL, follows its exact VM
graph pointer, reads the graph in bounded pages, removes only documented
post-publish system predicates, appends the KA-level private commitment, and
rebuilds the leaf set. It does not issue one query per RDF subject.

## Sync memory bound

The first page of every sync phase executes a store-bounded ordered query with
`LIMIT`, rather than first loading and sorting the full graph in Node.js. A
stable keyset cursor is preferred; an offset cursor is an acceptable temporary
fallback only when mutation is excluded or end-to-end Merkle verification
forces a restart on inconsistency.

Snapshot caching is an optimization after bounded reads. Admission limits must
be enforceable before a complete HTTP response is parsed.

## Rollout

1. Land the scope type, wire fields, versioned protocol/topic gate, and
   read-only legacy adapter while writers remain disabled.
2. Convert WM/SWM/VM storage, sync, proof, private content, and finalization to
   exact per-KA graphs and remove new-path root metadata.
3. Upgrade all nodes in a CG and verify they advertise the graph-scope
   capability. No active old-version writer may remain.
4. Enable v2 writers. Existing local V10 data remains queryable but immutable.
5. Keep an export tool for legacy data; do not add migration-on-write or dual
   protocol emission.

## Completion gates

- No v2 seal, lifecycle/share metadata, manifest, snapshot, ownership, private
  key, publish/update selector, finalization record, or proof path contains an
  explicit root-entity list.
- Multi-subject and same-subject-in-two-KAs tests prove graph isolation.
- Public and private Merkle/proof reconstruction matches publisher output.
- A legacy KA remains queryable/exportable through the read-only adapter, and
  every attempted legacy mutation fails with `LEGACY_KA_READ_ONLY`.
- A late-joining auto-approved private-CG member syncs every successfully
  created KA from a 50 x 1,000-triple run.
- At least 95% of operations succeed, every successful KA verifies exactly,
  and no daemon/Oxigraph process crashes, OOMs, or remains saturated.
