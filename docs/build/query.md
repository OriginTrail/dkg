---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Query Knowledge

Use `dkg_memory_search` for free-text recall and `dkg_query` for precise SPARQL.

## Free-text recall

Use memory search when the user asks what the node remembers about a topic:

```text
dkg_memory_search({ query: "relay discovery", limit: 10 })
```

Search ranks higher-trust memory above lower-trust memory:

```text
Verified Memory > Shared Working Memory > Working Memory
```

## Structured query

Use SPARQL when you know the graph pattern:

```sparql
SELECT ?s ?p ?o
WHERE {
  GRAPH ?g { ?s ?p ?o }
}
LIMIT 25
```

When querying sub-graph-routed data, use named graph patterns with `GRAPH ?g { ... }`. Many empty-query bugs come from asking the default graph while the data lives in named graphs.

