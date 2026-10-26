# Private Knowledge Asset partitions over HTTP

The named-KA HTTP API accepts private RDF alongside public RDF. This is the KA's
private partition, separate from whether its Context Graph is public or private.
These routes use the existing private-content store, sealing and publication
implementation; they do not change replication, pricing or blockchain calls.

## Write

`POST /api/knowledge-assets` and `POST /api/knowledge-assets/{name}/wm/write`
accept `quads` (public), `privateQuads` (private), or both:

```json
{
  "contextGraphId": "<existing CG ID>",
  "name": "inspection-123",
  "finalize": false,
  "privateQuads": [
    {
      "subject": "urn:inspection:123",
      "predicate": "urn:inspection:result",
      "object": "\"approved\""
    }
  ]
}
```

The example is a create request. For `wm/write`, the name is in the path and
`finalize` is not a write option. Both routes accept `subGraphName` as before.
Omit `graph` or set it to `""` on private quads; caller-selected graph placement
and protocol-reserved private subjects are rejected. Both arrays pass RDF-term
and literal-size validation before creating the KA or writing either partition.
Storage failures after validation can still leave a partial write; inspect the
existing draft before retrying.

A create request with nonempty public **or private** quads seals by default.
Use `finalize: false` for an editable draft. A sealed KA rejects further writes.
Private content then follows the ordinary finalize, SWM share and VM publish
routes. Private-only input is supported. The `writtenPrivate` response field
counts supplied private quads; it is not a count of newly inserted unique RDF
statements.

## Read one private partition

Send the owning agent's bearer token, the exact `contextGraphId` and, when used,
`subGraphName`:

```text
GET /api/knowledge-assets/{identifier}/wm/quads?contextGraphId=...&partition=private
GET /api/knowledge-assets/{identifier}/vm/quads?contextGraphId=...&partition=private
```

The identifier can be the local KA name, UAL or compact agent/KA-number alias.
These routes run the existing CG read-admission checks and additionally require
the authenticated KA owner. An authenticated node operator retains operator
access. Another CG member, an explicit `agentAddress` selector, or anonymous
access to a public CG does not grant access to this private partition. The
existing local-curator WM admission rules remain in force.

WM returns the current editable private draft as `{quads, count,
partition: "private"}`. It does not reconstruct an archived sealed draft.
VM reads only locally held content for the current confirmed KA version. It
verifies the metadata's subgraph, private triple count and private Merkle root,
and checks that the lifecycle descriptor still points at that version. The
response includes `ual`, `assertionVersion`, `merkleRoot`, `privateMerkleRoot`
when present, `privateTripleCount`, `quads`, `count` and `partition`. A transaction
hash is included when the local confirmation metadata contains one. This route
does not fetch missing content from another node or independently recheck chain
finality.

Unauthorized reads return 403; unavailable CG authority returns 503. Unconfirmed,
missing, altered or inconsistent VM content returns a 409 with a `PRIVATE_KA_*`
code and no private payload. The read never opens a draft or republishes a KA.

Omitting `partition` preserves existing public WM reads. General `/api/query`
does not gain a private-data bypass, and this change does not add public VM
`/quads` reads or expose private RDF through generic CG queries.

## Validation

`packages/cli/test/knowledge-assets-private-partitions.test.ts` exercises real
HTTP handlers, an agent and RDF storage. Its default backend is Oxigraph. For a
disposable Blazegraph namespace, set `DKG_PRIVATE_HTTP_BLAZEGRAPH_URL` when
running that test. The VM fixtures contain synthetic confirmed metadata; these
tests do not mint assets on a live network.
