# Graphify import of the DKG v10 codebase into a DKG v10 node

This note documents a local experiment that used [Graphify](https://github.com/yaniv-golan/graphify) output as a codebase knowledge graph and imported it into a DKG v10 node as Working Memory.

The goal was to validate that a large, generated code graph can be represented inside a DKG v10 Context Graph without publishing it to chain or pushing it directly into Shared Memory.

## Summary

- **Source repository:** `OriginTrail/dkg`
- **Source revision imported:** `cbef736fdb42873de0b0d7d8f52ac9a1a5067d30` (`v10.0.0-rc.9` tag commit)
- **Graphify output:** `graphify-out/graph.json`
- **Graphify graph size:**
  - `25,484` nodes
  - `146,724` links / edges
- **DKG Context Graph:** `dkg-v10-codebase-graphify`
- **DKG sub-graph:** `code`
- **Layer:** Working Memory only
- **Import mode:** partitioned assertions, not one monolithic assertion
- **Observed post-import DKG counts:**
  - `174,113` entities
  - `1,716,323` triples

The import stayed private to the local node by default. No Shared Memory promotion or Verified Memory publishing was performed as part of the baseline import.

## Why Graphify + DKG

Graphify produces a codebase graph that captures files, symbols, relations, source locations, communities, and cross-file links. Importing that graph into DKG v10 makes the codebase available through the same memory model used by agents:

1. **Working Memory:** local, private, fast iteration over generated code context.
2. **Shared Memory:** optional promotion of reviewed slices to collaborating agents.
3. **Verified Memory:** optional later anchoring for durable, attestable codebase snapshots.

This is useful for agent development because code context becomes queryable alongside chat, tasks, decisions, and other project knowledge.

## Partitioning strategy

The DKG v10 codebase graph is too large for a single assertion. The experiment used partitioned Working Memory assertions:

- one manifest assertion
- source/path-based partition assertions
- cross-partition edge assertions

Planned import shape:

- **Partition assertions:** `graphify-cbef736f-<partition>`
- **Cross-link assertions:** `graphify-cbef736f-cross-links-<nnn>`
- **Manifest assertion:** `graphify-cbef736f-manifest`
- **Total assertion count:** `74`
- **Partition quads:** `1,624,012`
- **Cross-link quads:** `104,224`
- **Manifest quads:** `657`

Example partition records from the generated plan:

```json
[
  {
    "key": "bench",
    "assertion": "graphify-cbef736f-bench",
    "nodes": 122,
    "internalEdges": 564,
    "quads": 6611
  },
  {
    "key": "packages/query",
    "assertion": "graphify-cbef736f-packages-query",
    "quads": 16781
  },
  {
    "key": "docs/SPEC_PART1_MARKETPLACE.md",
    "assertion": "graphify-cbef736f-docs-spec_part1_marketplace.md",
    "nodes": 113,
    "internalEdges": 336,
    "quads": 4049
  }
]
```

## RDF shape

The import used a small Graphify namespace:

```text
https://schema.origintrail.io/graphify/
```

Representative entity types:

- `graphify:GraphSnapshot`
- `graphify:CodeEntity`
- `graphify:CodeRelation`
- `graphify:GraphPartition`

Representative predicates:

- `graphify:contextGraphId`
- `graphify:sourceGraphPath`
- `graphify:gitCommit`
- `graphify:nodeCount`
- `graphify:edgeCount`
- `graphify:hasPartition`
- `graphify:hasPartitionAssertion`
- `graphify:hasCrossPartitionEdge`
- `graphify:source`
- `graphify:target`
- `graphify:relation`
- `graphify:sourceFile`

The importer keeps URI-like RDF objects bare and serializes literal values as quoted RDF literals before sending them to `/api/assertion/:name/write`. This avoids parser failures for object values containing spaces or punctuation.

## Import command

The local import command used in the experiment was:

```bash
/Users/clawdnode/code/graphify-dkg-mvp/scripts/graphify_dkg_partitioned_sync.py \
  --graph /Users/clawdnode/code/dkg/graphify-out/graph.json \
  --context-graph dkg-v10-codebase-graphify \
  --project-name 'DKG V10 Codebase - Graphify' \
  --sub-graph code \
  --threshold 2500 \
  --write-batch-size 2000
```

The importer performs the following operations:

1. Reads the Graphify `graph.json` node-link output.
2. Creates or reuses the target Context Graph.
3. Creates or reuses the target sub-graph.
4. Partitions nodes by repository path/module boundary.
5. Writes one assertion per partition into Working Memory.
6. Writes cross-partition edges into separate assertions.
7. Writes a manifest assertion that describes the snapshot, partition plan, counts, and assertion names.

## Verification commands

Read the local auth token from the last non-comment line:

```bash
TOKEN=$(grep -v '^#' "$HOME/.dkg-dev/auth.token" | tail -n 1 | tr -d '\r\n')
```

Verify the sub-graph count:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:9200/api/sub-graph/list?contextGraphId=dkg-v10-codebase-graphify'
```

Observed result after the completed import:

```json
{
  "contextGraphId": "dkg-v10-codebase-graphify",
  "subGraphs": [
    {
      "name": "code",
      "uri": "did:dkg:context-graph:dkg-v10-codebase-graphify/code",
      "entityCount": 174113,
      "tripleCount": 1716323
    }
  ]
}
```

Verify that Working Memory assertion graphs contain queryable triples:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @- \
  http://127.0.0.1:9200/api/query <<'JSON'
{
  "contextGraphId": "dkg-v10-codebase-graphify",
  "sparql": "SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \"did:dkg:context-graph:dkg-v10-codebase-graphify/\") && CONTAINS(STR(?g), \"/assertion/\")) } LIMIT 5"
}
JSON
```

A successful response returns bindings from graphs shaped like:

```text
did:dkg:context-graph:dkg-v10-codebase-graphify/code/assertion/<agent-address>/graphify-cbef736f-cross-links-001
```

## Node UI observations

Two UI/runtime observations came out of the experiment:

1. The full `/api/context-graph/list` endpoint can time out on a local node after the large Graphify import, while direct endpoints such as `/api/sub-graph/list` and `/api/query` still work.
2. A project shell can be visible in the UI even when the large Working Memory import is absent or has not survived a daemon restart; the UI should verify the sub-graph and WM assertion data separately.

Those findings are useful follow-up work for improving large local code-graph UX in the node UI.

## Persistence observation

During local validation, the Graphify import was successfully written and queryable in Working Memory. However, after daemon stop/start cycles on the local development node, the large Working Memory import did not always fully survive restart. The Context Graph shell could remain visible while the `code` sub-graph returned no entries or a lower persisted count.

This should be treated as a durability/flush follow-up before relying on very large generated Working Memory imports as restart-stable state.

## Follow-up opportunities

- Add an official Graphify importer or integration package under the DKG v10 integration model.
- Add resumable partition import metadata so interrupted imports can restart at the first incomplete assertion.
- Add node UI affordances for large code graphs: direct sub-graph loading, paged entity browsing, and explicit “import present but still loading” states.
- Add persistence stress tests for large Working Memory assertion sets.
- Optionally promote reviewed codebase slices to Shared Memory so multiple agents can collaborate on the same source graph.
