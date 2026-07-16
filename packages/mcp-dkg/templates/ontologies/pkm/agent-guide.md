# PKM agent guide

This starter ships an RDF ontology for **PKM (Personal Knowledge
Management) projects** — Notes, Highlights, Insights, and the links
that grow a knowledge garden organically. The formal schema lives in
`ontology.ttl` alongside this guide.

For V10 MCP tool usage, see
[`packages/cli/skills/dkg-node/SKILL.md`](../../../../cli/skills/dkg-node/SKILL.md).
The tool surface to use against this ontology:

- `dkg_knowledge_asset_create` + `dkg_knowledge_asset_write` — populate (WM)
- `dkg_knowledge_asset_finalize` — seal the draft (the "git commit")
- `dkg_knowledge_asset_share` — share with peers (SWM)
- `dkg_knowledge_asset_publish` — mint on chain (VM); returns the asset's UAL
- `dkg_query` — SPARQL read; `dkg_memory_search` — free-text recall

The longer per-domain agent-guide walkthrough format will return when
the V10 ontology endpoint and per-project annotation workflow stabilise.
