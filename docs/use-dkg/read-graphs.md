---
status: current
version: v10
audience: human+agent
doc_type: runbook
---

# Read Graphs

A view query (`POST /api/query` with a `view`) matches each pattern inside one asset graph at a time. That is `semantics: "per-asset"`, the default. A node can also keep a **read graph** for a context graph and a memory layer: one graph that holds the union of that layer's asset graphs. View queries can then match patterns across assets (`semantics: "merged"`), and the node does not list the asset graphs to answer them.

Read graphs are off by default. This page switches the verifiable memory of one context graph to read graphs, one step at a time, and says how to back out at any step. Per-asset answers never depend on a read graph.

## Modes

`query.readGraphs` in `~/.dkg/config.json` sets a mode for each context graph and layer:

| Mode | What the node does |
| --- | --- |
| `off` | Keeps no read graph. This is the default. |
| `build` | Builds the read graph, updates it on every write to the layer, and checks it. No query reads it. |
| `serve` | The same as `build`, and view queries that ask for `merged` read it. |

- **Precedence:** the most specific setting wins:
  1. a context graph's mode for the layer;
  2. that context graph's default;
  3. the node's mode for the layer;
  4. the node's default.
- **Names:** layers use the view names of `/api/query` (`working-memory`, `shared-working-memory`, `verifiable-memory`). A context graph is named by its ID.
- **When it applies:** the daemon reads the section at start, so restart it after every change. An unknown key or value stops the start with `QUERY_CONFIG_INVALID` and names the key.

## Before you start

- **The store must support read graphs.** These stores do:
  - Blazegraph;
  - the managed `oxigraph-server`;
  - embedded Oxigraph;
  - a `sparql-http` endpoint whose `consistencyProfile` is `atomic-update` or stronger.

  On any other store the daemon refuses to start with read graphs on (`READ_GRAPHS_UNSUPPORTED`).
- **The rollback target must recognize read graphs.** The rollback target is the release `dkg rollback` would activate: the other slot on a Core, or the version in `previous-version` on an Edge. A release that does not recognize read graphs would treat them as ordinary graphs, so `dkg start` refuses read graphs while the target is such a release:

  ```text
  [QUERY-CONFIG] 1 validation error(s) - refusing to start.
    query.readGraphs: must be "off" while the rollback target (…) is older than …, the first release that recognizes read graphs
  ```

- **Plan for the space.** A read graph holds one copy of each distinct triple of its layer. The store grows by up to the size of that layer.

## Switch a context graph's verifiable memory

The examples use the context graph `my-project`.

### 1. Set `build`

Add a rule for the context graph to the `query` section of `~/.dkg/config.json`:

```json
"query": {
  "readGraphs": {
    "contextGraphs": {
      "my-project": { "layers": { "verifiable-memory": "build" } }
    }
  }
}
```

Restart the daemon:

```bash
dkg stop
dkg start
```

- **Backfill:** the node fills the read graph on its background lane, so client queries and writes go first.
- **Writes:** from then on, every write to the layer's asset graphs also updates the read graph.

### 2. Wait for `ready`, then run the full check

Watch the state of the context graph's read graphs:

```bash
dkg store read-graphs status
```

When they show `ready`, compare each read graph with its asset graphs, in both directions:

```bash
dkg store read-graphs check --full
```

- **What the full check finds:** a triple an asset graph holds that the read graph lacks, and a triple the read graph holds that no asset graph holds.
- **A mismatch:** the read graph is marked dirty and rebuilt before it serves.
- **The sampled check:** the node also runs one in the background for as long as the read graph exists.

### 3. Run your workload, then check again

Let the node take its usual traffic, or drive every kind of write it takes:

- creating and sharing assets;
- promoting and publishing them;
- updates and removals;
- sync and catch-up;
- sub-graph registration;
- drafts.

Then run `dkg store read-graphs check --full` again.

### 4. Read the delta report with the context graph's owner

```bash
dkg view-semantics report -c my-project
```

The command needs the node-admin token.

- **How it is built:** while the read graph is `ready`, the node samples view queries on the context graph and compares the merged answer with the per-asset one.
- **What it shows:** how many sampled queries would get the same rows, how many lose only duplicate copies, and how many would get other rows. It lists the query shapes behind the changed rows.
- **Where changed rows come from:** patterns that join triples of different assets.

Go on only when the context graph's owner and its callers expect those answers.

### 5. Set `serve`

Change the mode to `serve`, and restart:

```json
"my-project": { "layers": { "verifiable-memory": "serve" } }
```

The read graph stays `ready` across the restart. Callers can now ask for merged answers, per request:

```json
{
  "contextGraphId": "my-project",
  "view": "verifiable-memory",
  "semantics": "merged",
  "sparql": "SELECT ?product ?maker WHERE { ?product <https://schema.org/manufacturer> ?m . ?m <https://schema.org/name> ?maker }"
}
```

- **Requests without `semantics`** still get per-asset answers.
- **The response's `semantics` field** says which semantics answered.

### 6. Make `merged` the default (optional)

When the context graph's callers are ready, make `merged` the default for requests that do not ask:

```json
"query": {
  "readGraphs": {
    "contextGraphs": { "my-project": { "layers": { "verifiable-memory": "serve" } } }
  },
  "viewSemantics": { "contextGraphs": { "my-project": "merged" } }
}
```

- **Pinning:** a caller can still pin `"semantics": "per-asset"`.
- **Other layers:** a request that takes the default on a layer the node does not serve is answered per asset.

## Back out

At any step, set the layer back to `off` and restart.

- **Queries:** answered per asset from the start.
- **The read graph:** the node no longer trusts it and marks it dirty at start.
- **To reclaim the space:**

  ```bash
  dkg store read-graphs drop -c my-project
  ```

- **`dkg rollback`:** it drops the read graphs as part of the rollback.

## What you'll see

| Signal | Meaning |
| --- | --- |
| A state in `dkg store read-graphs status`: `building`, `ready`, `dirty`, `repairing` or `rebuilding` | Only a `ready` read graph is checked and served. |
| `[read-graph-check] Read graph <…> does not equal the union of its member graphs (…)` in the daemon log | A check found a mismatch. The read graph is marked dirty and rebuilt before it serves again. |
| `dkg.store.read_graph_mismatches_total` | Mismatches, as a counter. Alert on any increase. |
| `dkg.store.read_graph_checks_total`, `dkg.store.read_graph_check_ms` | Checks by mode, outcome and layer, and how long they take. |
| `dkg.store.read_graphs` | Read graphs by state. |
| `503 VIEW_NOT_READY` with `Retry-After` | A merged request while the read graph is not `ready`, for example during a rebuild. Per-asset requests are not affected. |
| `400 SEMANTICS_UNSUPPORTED` | A merged request where merged answers do not apply, such as a layer the node does not serve. |

Metrics are exported once an OTLP endpoint is set; see [Monitor Store and Queue Pressure](backpressure-observability.md).

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `dkg start` refuses: `READ_GRAPHS_UNSUPPORTED` | The store cannot maintain read graphs. Set `off`, or move to a store listed above. |
| `dkg start` refuses: the rollback target is older than the first release that recognizes read graphs | Update so that the rollback target recognizes read graphs, or set `off`. |
| A read graph stays `dirty` or `rebuilding` | Merged requests get `503` until it is `ready`; per-asset answers keep working. Look for the check line in the daemon log. If it repeats, set `off` and open an issue with those log lines. |
| Writes are slower | Compare the store's queue waits with the layer on and off ([Monitor Store and Queue Pressure](backpressure-observability.md)). Set `off` for the layer if they rise. |
