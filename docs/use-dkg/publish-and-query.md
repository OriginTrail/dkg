---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Publish & Query

The default DKG V10 write lifecycle is:

```
Working Memory -> Shared Working Memory -> Verifiable Memory
```

Use Working Memory first when an agent is drafting or iterating. Share to Shared Working Memory when peers should see it. Publish to Verifiable Memory only when the knowledge needs durable on-chain finality, and the wallet has funds.

```mermaid
flowchart LR
  WM["Working Memory draft"] --> Finalize["Finalize / seal"]
  Finalize --> SWM["Share to Shared Working Memory"]
  SWM --> VM["Publish to Verifiable Memory"]
```

## CLI shape

```bash
dkg context-graph create my-project
CG="<agentAddress>/my-project"
dkg ka import-file notes --input-file ./notes.md -c "$CG"
dkg ka query notes -c "$CG"
dkg context-graph register "$CG"
dkg ka finalize notes -c "$CG"
dkg ka share notes -c "$CG"
dkg ka publish-async notes -c "$CG"
```

Bare context-graph IDs are scoped by the daemon before use. After `create`, use the `ID:` printed by the CLI for later commands; it has the form `<agentAddress>/my-project`.

Use `dkg ka create notes -c "$CG" --input-file ./notes.ttl --share` when the local source is RDF and you want one command to create, write, finalize, and share. This convenience stops at Shared Working Memory; it does not publish to Verifiable Memory.

Use `dkg ka share notes -c "$CG"` when you want to stop at Shared Working Memory without publishing to Verifiable Memory.

Use `dkg ka publish-async notes -c "$CG"` to enqueue the Verifiable Memory publish after the KA has been finalized and fully shared to SWM. `dkg publisher publish-async "$CG" notes` remains an operational alias for the same async VM publish route. See [Async Publisher Wallets](async-publisher-wallets.md) for funding and optional attribution identity setup.

## Agent shape

Agents should follow the Node Skill lifecycle (create → write → finalize → share → publish):

* `dkg_knowledge_asset_create`
* `dkg_knowledge_asset_write`
* `dkg_knowledge_asset_finalize`
* `dkg_knowledge_asset_query`
* `dkg_knowledge_asset_share` (formerly `dkg_assertion_promote`)
* `dkg_knowledge_asset_publish`

Do not publish to Verifiable Memory just because data exists. Publishing spends gas/TRAC and should be an explicit finality choice.

## Query Knowledge

Use `memory_search` (`dkg_memory_search` on the MCP runtime) for free-text recall and `dkg_query` for precise SPARQL.

### Free-text Recall

Use memory search when the user asks what the node remembers about a topic:

```
memory_search({ query: "relay discovery", limit: 10 })
```

Search ranks higher-trust memory above lower-trust memory:

```
Verifiable Memory > Shared Working Memory > Working Memory
```

### Structured Query

Use SPARQL when you know the graph pattern:

```sparql
SELECT ?s ?p ?o
WHERE {
  GRAPH ?g { ?s ?p ?o }
}
LIMIT 25
```

When querying sub-graph-routed data, use named graph patterns with `GRAPH ?g { ... }`. Many empty-query bugs come from asking the default graph while the data lives in named graphs.
