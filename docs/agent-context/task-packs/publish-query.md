---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Task Pack: Publish and Query

## Write path

1. Create or select a Context Graph.
2. Create a Working Memory assertion.
3. Write RDF quads.
4. Query the assertion to verify.
5. Promote to Shared Working Memory when peers should see it.
6. Publish to Verifiable Memory only with explicit finality intent.

Node Skill tools:

- `dkg_context_graph_create`
- `dkg_assertion_create`
- `dkg_assertion_write`
- `dkg_assertion_query`
- `dkg_assertion_promote`
- `dkg_shared_memory_publish`

## Query path

- Use `dkg_memory_search` for recall.
- Use `dkg_query` for SPARQL.
- Use `GRAPH ?g { ... }` for sub-graph-routed data.
