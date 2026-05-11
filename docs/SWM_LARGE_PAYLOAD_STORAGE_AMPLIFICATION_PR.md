# Fix SWM Large Payload Storage Amplification

## Summary

This change fixes Shared Working Memory large-payload storage amplification.
Before this fix, each public SWM payload was stored twice per node:

1. Once as normal RDF quads in the SWM data graph.
2. Again as a JSON-stringified RDF literal in SWM metadata through
   `dkg:publicStagedQuads`.

For large replicated writes this doubled the effective Oxigraph payload and
pushed the WASM store into memory failures. In the reproduced benchmark, the
duplicated path failed around `202.5 MiB/store` with:

```text
RuntimeError: unreachable
Store.load(...)
```

After that failure, later queries could also fail with:

```text
table index is out of bounds
```

The fix replaces full-payload metadata snapshots with compact operation
metadata. New SWM writes store only references and provenance in
`_shared_memory_meta`, while the public payload remains in the SWM data graph.
Legacy metadata records that already contain `dkg:publicStagedQuads` remain
readable.

## Problem

The old SWM share path made metadata carry the entire public payload:

```mermaid
flowchart TD
  A["Client writes public SWM quads"] --> B["Store quads in SWM graph"]
  A --> C["Serialize same quads as JSON"]
  C --> D["Store JSON string as dkg:publicStagedQuads literal"]
  B --> E["Oxigraph stores payload copy 1"]
  D --> F["Oxigraph stores payload copy 2"]
  E --> G["Large payload memory pressure"]
  F --> G
```

That metadata snapshot was useful for later lift/share resolution, but it made
the storage model scale with approximately `2x payload size` per node. The
failure was reproduced without private mode and without Sender Key encryption,
so the root cause was public SWM metadata amplification.

## New Model

New SWM writes store compact share-operation metadata:

- context graph id
- optional subgraph name
- share operation id
- root entities
- publisher peer id
- published timestamp

The public payload is not serialized into metadata. Resolution reconstructs the
operation payload by reading the current SWM graph for the operation roots.

```mermaid
flowchart TD
  A["Client writes public SWM quads"] --> B["Store quads in SWM graph"]
  A --> C["Generate compact metadata"]
  C --> D["dkg:shareOperationId"]
  C --> E["dkg:rootEntity"]
  C --> F["dkg:publisherPeerId"]
  C --> G["dkg:publishedAt"]
  C --> H["dkg:contextGraphId"]
  C --> I["optional dkg:subGraphName"]
  B --> J["Single payload copy in Oxigraph"]
  D --> K["Small operation reference metadata"]
  E --> K
  F --> K
  G --> K
  H --> K
  I --> K
```

## Write Path

The SWM write path still persists and gossips the public payload normally. The
change is only in the metadata generated for the operation.

```mermaid
sequenceDiagram
  participant Client
  participant API as DKG API
  participant Publisher as DKGPublisher
  participant Store as Triple Store
  participant Gossip as SWM Gossip

  Client->>API: POST /api/shared-memory/write
  API->>Publisher: share(contextGraphId, quads, subGraphName?)
  Publisher->>Store: store public quads in SWM graph
  Publisher->>Store: store compact share metadata
  Publisher->>Gossip: broadcast SWM operation
  Gossip-->>API: operation propagated to peers
  API-->>Client: shareOperationId
```

The important behavior change is this:

```text
New writes no longer emit:
  <share-operation> dkg:publicStagedQuads "<serialized full payload>"
```

Instead they emit compact metadata that points to roots already present in the
SWM data graph.

## Resolution Path

Lift/share resolution now resolves the public payload from the graph itself
when compact metadata is present.

```mermaid
flowchart TD
  A["Lift request contains shareOperationId"] --> B["Read share operation metadata"]
  B --> C{"Legacy dkg:publicStagedQuads present?"}
  C -->|Yes| D["Parse legacy serialized quad snapshot"]
  C -->|No| E["Read root entities from metadata"]
  E --> F["Query current SWM graph for those roots"]
  F --> G["Return public quads for operation"]
  D --> G
  G --> H["Build lift request payload"]
```

For compact metadata, the resolver validates the operation roots and then reads
the public quads from the current SWM graph. This keeps new writes small while
preserving the ability to lift and publish shared-memory content.

## Legacy Compatibility

Existing stores may already contain `dkg:publicStagedQuads`. Those records still
work. The compatibility rule is:

```mermaid
flowchart LR
  A["Existing metadata record"] --> B{"Has dkg:publicStagedQuads?"}
  B -->|Yes| C["Use legacy serialized snapshot"]
  B -->|No| D["Use compact root metadata"]
  C --> E["Resolved public quads"]
  D --> E
```

This means the fix is forward-looking for new writes, while old metadata remains
readable and does not need a migration before use.

## Benchmark

This PR adds a reusable live benchmark:

```bash
pnpm bench:swm-large-payload -- \
  --ports 19101,19102,19103,19104,19105 \
  --payload-mib-per-node 100 \
  --chunk-mib 0.5 \
  --output bench/results/swm-large-payload-500mib.json
```

The benchmark:

1. Writes large public SWM literals through each configured node.
2. Polls every node until all benchmark payloads are queryable.
3. Checks per-run metadata for `shareOperationId`, `rootEntity`,
   `publisherPeerId`, and `publishedAt`.
4. Verifies `dkg:publicStagedQuads` did not grow.
5. Optionally scans appended daemon logs for known Oxigraph and GossipSub
   failure signatures.

```mermaid
sequenceDiagram
  participant Bench as Benchmark
  participant N1 as Node 1
  participant N2 as Node 2
  participant N3 as Node 3
  participant N4 as Node 4
  participant N5 as Node 5

  Bench->>N1: write 100 MiB in chunks
  Bench->>N2: write 100 MiB in chunks
  Bench->>N3: write 100 MiB in chunks
  Bench->>N4: write 100 MiB in chunks
  Bench->>N5: write 100 MiB in chunks

  N1-->>N2: gossip SWM operations
  N1-->>N3: gossip SWM operations
  N2-->>N4: gossip SWM operations
  N3-->>N5: gossip SWM operations
  N4-->>N1: gossip SWM operations
  N5-->>N2: gossip SWM operations

  loop Until every node converges
    Bench->>N1: count benchmark payloads
    Bench->>N2: count benchmark payloads
    Bench->>N3: count benchmark payloads
    Bench->>N4: count benchmark payloads
    Bench->>N5: count benchmark payloads
  end

  Bench->>N1: verify compact metadata
  Bench->>N2: verify compact metadata
  Bench->>N3: verify compact metadata
  Bench->>N4: verify compact metadata
  Bench->>N5: verify compact metadata
```

The reproduced 5-node regression case used `5 x 100 MiB = 500 MiB` total. With
the compact metadata model, all five nodes converged with:

```text
payload quads:        1000 per node
dkg:publicStagedQuads: 0 per node
shareOperationIds:    1000 per node
rootEntities:         1000 per node
```

No Oxigraph failure signatures were observed:

```text
RuntimeError: unreachable
table index is out of bounds
```

## Files Changed

- `packages/publisher/src/workspace-resolution.ts`
  - Stops writing new full-payload `dkg:publicStagedQuads` metadata snapshots.
  - Resolves compact share operations by reading root-scoped public quads from
    the SWM graph.
  - Keeps legacy snapshot reads for existing metadata.

- `packages/publisher/src/metadata.ts`
  - Extends share metadata with compact operation fields.
  - Emits `dkg:publishedAt`, `dkg:shareOperationId`, `dkg:rootEntity`,
    `dkg:publisherPeerId`, `dkg:contextGraphId`, and optional
    `dkg:subGraphName`.

- `packages/publisher/src/dkg-publisher.ts`
  - Routes SWM share metadata generation through the compact metadata helper.

- `packages/publisher/src/workspace-handler.ts`
  - Applies the same compact metadata model for received SWM operations.

- `packages/publisher/test/async-lift-workspace.test.ts`
  - Covers compact share-operation resolution.
  - Covers legacy `dkg:publicStagedQuads` compatibility.
  - Covers large literal writes without metadata payload duplication.

- `packages/publisher/test/metadata.test.ts`
  - Covers the new compact share metadata shape.

- `packages/cli/scripts/swm-large-payload-benchmark.cjs`
  - Adds the reusable live multi-node SWM payload benchmark.

- `packages/cli/test/swm-large-payload-benchmark.test.ts`
  - Covers benchmark argument parsing, chunk planning, and generated payload
    sizing.

- `packages/cli/README.md`
  - Documents the benchmark and the 5-node 500 MiB regression command.

## Validation

Focused validation run for this change:

```bash
pnpm --filter @origintrail-official/dkg exec vitest run test/swm-large-payload-benchmark.test.ts
```

Additional validation performed during the fix:

```bash
git diff --check
```

Live benchmark validation:

```bash
pnpm bench:swm-large-payload -- \
  --ports 19101,19102,19103,19104,19105 \
  --payload-mib-per-node 100 \
  --chunk-mib 0.5 \
  --auth-token <token> \
  --output bench/results/swm-large-payload-500mib.json
```

The full 500 MiB run verified that each node could query all benchmark payloads
and that `dkg:publicStagedQuads` remained at zero for the new writes.
