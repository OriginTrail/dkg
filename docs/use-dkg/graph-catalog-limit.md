---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Size the graph catalog limit

The node keeps a catalog of the named graphs in its store: their names, held in
memory and refreshed from the store. Queries use it to find a context graph's
graphs without listing the store each time.

One node-side limit bounds every full read of the catalog:
`store.graphCatalog.maxBytes` in the node's config, 256 MiB by default. The node measures the
catalog as its graph names written as one JSON array. Past the limit, catalog
reads fail closed with `STORE_INTERNAL_LIMIT`, and the daemon answers the
queries that need the catalog with a retryable `503`. The node never serves a
catalog cut short.

## Watch for the warning

When a refreshed catalog reaches 50 % and then 80 % of the limit, the node logs
a warning at the `WARN` level, from the `graph-catalog` module:

```text
The graph catalog has reached 80% of its internal limit STORE_GRAPH_CATALOG_MAX_BYTES: 214748365 of 268435456 bytes, 1830000 graphs. At the limit, catalog reads fail with STORE_INTERNAL_LIMIT; raise store.graphCatalog.maxBytes or DKG_STORE_GRAPH_CATALOG_MAX_BYTES before then.
```

It logs once when the catalog reaches a level, and again every hour while the
catalog stays there.

Past the limit, the node logs a warning that starts the same way when the limit
refuses a catalog read, and again every hour while reads are still refused:

```text
The graph catalog has reached 80% of its internal limit STORE_GRAPH_CATALOG_MAX_BYTES, and is over it: at least 270532608 of 268435456 bytes. Catalog reads fail with STORE_INTERNAL_LIMIT until the limit is raised: store.graphCatalog.maxBytes or DKG_STORE_GRAPH_CATALOG_MAX_BYTES.
```

The alert set in `tools/observability` has a rule on the 80 % warning:
"Graph catalog at 80% of its limit on a node". It fires while the warning keeps
coming, over the limit too, and resolves about 80 minutes after the last one.

When the node exports metrics, the same numbers are there:

| Metric | What it shows |
| --- | --- |
| `dkg.store.graph_catalog_bytes` | The catalog's measured size at its last refresh |
| `dkg.store.graph_catalog_graphs` | The graphs in the catalog at its last refresh |
| `dkg.store.graph_catalog_refresh_failures_total` | Failed refreshes; `reason="internal_limit"` when the limit refused one |
| `dkg.query.internal_limit_total` | Reads a node-side limit refused, by `limit` |

## Raise the limit

Set `store.graphCatalog.maxBytes`, in bytes, in `~/.dkg/config.json`, and
restart the node:

```json
{
  "store": {
    "graphCatalog": { "maxBytes": 536870912 }
  }
}
```

On a node with a configured store, put `graphCatalog` next to its `backend`. A
`store` section that holds only settings keeps the default store.
`DKG_STORE_GRAPH_CATALOG_MAX_BYTES` in the daemon's environment wins over the
setting. A value that is not a positive whole number of bytes, in either place,
stops the node at start with a message that names it.

Size it from the catalog the warning reports:

- Graph names of the kind the DKG writes measure about 120 bytes each in the
  catalog. The large-catalog test fixture (100,306 graphs in four context
  graphs) measures 11.8 MB.
- Set the limit to at least twice the catalog's current size, so it has room to
  grow. For example, 2 million graphs measure about 240 MB, and a limit of
  512 MiB (`536870912`) leaves room for about twice that.

The node holds the catalog in memory. In a measurement with names of that size,
the in-memory catalog took about 1.3 times its measured size, and about 2.7
times while a refresh replaced it with a new one. Node.js caps the daemon's
heap: the default depends on the machine's memory, and
`NODE_OPTIONS=--max-old-space-size=<MiB>` in the daemon's environment sets it.
Leave the heap room for about three times the limit above the node's other use.

### A SPARQL endpoint configured by hand

A store the node manages, a Blazegraph store and an embedded Oxigraph store all
send the full graph list in about the catalog's own measure. A SPARQL endpoint
configured by hand with the catalog switched on (`"graphSetIndex": true`, see
[Storage Backends](storage-sparql-http.md)) sends it as SPARQL JSON, which takes
at least 28 more bytes per graph. Its full reads can reach the limit before the
catalog measures 80 % of it, so on such a store raise the limit at the 50 %
warning.
