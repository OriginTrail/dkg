# Large content on the DKG

The DKG replicates RDF graphs across many independently operated nodes running
different triple-store backends. To keep every node able to store every graph,
**a single RDF literal (one text value in one triple) must stay at or below
60,000 bytes** (measured as Java modified-UTF-8, roughly: bytes of UTF-8 text).

Why this limit exists:

- One supported backend (Blazegraph) has a hard ~64 KB per-string storage
  limit. A literal above it can never be stored by those nodes, so a graph
  containing one would permanently diverge across the network.
- Very large literals are also a replication-health problem: every subscribed
  node downloads and re-serves them on sync, so one oversized value multiplies
  into network-wide bandwidth and storage cost.

## What happens if you exceed it

Writes containing an oversized literal are rejected with a structured
`OVERSIZED_RDF_LITERAL` error (HTTP 400 on the API routes). The error names the
subject, predicate, and byte size so you can locate the offending value. This
applies to publishes, updates, imports, shared-memory writes, and context-graph
registration metadata (names, descriptions).

## How to publish large content today

Two supported patterns:

1. **Chunk it.** Split the text into ordered parts, each below the limit, as
   separate triples/resources (e.g. `part 1..N` with an order index and a
   total count). Automatic chunking for large public `schema.org/text` values
   is in progress.
2. **Externalize it.** Store the body outside the graph (your own storage, an
   artifact store, IPFS, …) and publish a compact pointer instead: the
   content **URI**, its **SHA-256 hash**, **byte size**, media type, and a
   short **summary or excerpt** for discoverability. The hash in the triple
   keeps the external content verifiable — anyone can fetch the body and check
   it against the published hash, and for Knowledge Assets the hash is covered
   by the on-chain commitment.

As a rule of thumb: triples carry *structured knowledge and pointers*; bulk
text and binary bodies belong outside the triple store, bound by hash.

## Roadmap: first-class external content storage

We plan to make pattern 2 a built-in feature: publish large content in one
call, with the node storing the body in a content-addressed blob store and
emitting the pointer triples (URI + hash + size + excerpt) for you —
SPARQL-queryable metadata, verifiable integrity, without hand-rolling the
externalization. Until then, the two patterns above are the supported paths.
