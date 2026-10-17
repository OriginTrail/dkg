# Searching memory layers

`POST /api/memory/search` accepts `query`, `contextGraphId`, optional
`memoryLayers` (`wm`, `swm`, `vm`, all three by default), and `limit` (default
20, maximum 100). The caller must be authorized to read the Context Graph.

The response combines vector similarity and text matches. Within each layer,
vector matches come first, ordered by similarity, followed by text-only matches.
Results are selected in rounds across the requested layers, in request order,
until the limit is reached. This prevents a large Working Memory layer from
hiding every Shared or Verifiable Memory match. If the limit is smaller than
the number of nonempty layers, earlier requested layers receive the available
slots. Duplicate entities appear once, with their contributing `sources` merged.
`memoryLayer` identifies the layer from which that result was selected;
`resultCount` is the number of entries actually returned, not a total-match count.

A successful response can include:

```json
{
  "query": "invoice",
  "contextGraphId": "accounts",
  "resultCount": 1,
  "results": [
    {
      "entityUri": "urn:invoice:42",
      "label": "Invoice 42",
      "sources": ["sparql"],
      "similarity": null,
      "sourceFile": null,
      "snippet": null,
      "memoryLayer": "wm"
    }
  ],
  "unavailableLayers": [{ "layer": "swm", "reason": "read-authority" }]
}
```

`unavailableLayers` distinguishes a Shared Working Memory layer refused by its
read-admission gate from an admitted search that found no matches. It does not
expose private policy details, imply that the graph is empty, or change the
Context Graph authorization decision. Node-operator requests still pass through
the query engine's node-local authority checks.

Working Memory is scoped to the authenticated agent. A node operator can search
all locally registered agents, with at most four guarded text reads in flight.
Disconnecting cancels in-flight reads and prevents subsequent batches from
starting. Candidate retention is bounded by the result limit per layer.

Verifiable Memory uses the query engine's existing view semantics: it includes
the root content graph, per-Context-Graph materialized content graphs, and VM
partitions (including registered subgraphs). It excludes WM, SWM, and protocol
metadata. The search route does not implement a separate graph-prefix filter.

## Local devnet regression

Run against an existing local devnet node (creates a uniquely named public graph
and two test agents, including an on-chain Context Graph registration on that
local chain):

```sh
DKG_DEVNET_API_URL=http://127.0.0.1:9201 \
DKG_DEVNET_AUTH_FILE=.devnet/node1/auth.token \
node scripts/devnet-test-memory-search.mjs
```

The scenario creates drafts and shares through the production HTTP API, checks
that WM cannot crowd SWM out of a two-result search, and verifies per-agent WM
isolation and the operator's cross-agent search. The CLI integration suite runs
the identical scenario using its isolated daemon and local Hardhat chain.
