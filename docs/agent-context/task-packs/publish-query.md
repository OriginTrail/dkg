---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Task Pack: Publish and Query

## Write path

1. Create or select a Context Graph.
2. Create a Working Memory Knowledge Asset.
3. Write RDF quads.
4. Finalize (seal) the Knowledge Asset.
5. Query the Knowledge Asset to verify.
6. Share to Shared Working Memory when peers should see it.
7. Publish to Verifiable Memory only with explicit finality intent.

Node Skill tools:

- `dkg_context_graph_create`
- `dkg_knowledge_asset_create`
- `dkg_knowledge_asset_write`
- `dkg_knowledge_asset_finalize`
- `dkg_knowledge_asset_query`
- `dkg_knowledge_asset_share`
- `dkg_knowledge_asset_publish`
- `dkg_shared_memory_publish`

## Query path

- Use `memory_search` for recall (`dkg_memory_search` on the MCP runtime).
- Use `dkg_query` for SPARQL.
- Use `GRAPH ?g { ... }` for sub-graph-routed data.
