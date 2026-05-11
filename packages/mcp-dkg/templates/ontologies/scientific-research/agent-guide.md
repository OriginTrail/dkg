# Scientific-research agent guide

This starter ships an RDF ontology for **scientific-research projects** —
the empirical research arc (Hypotheses → Experiments → Results →
Reproducibility chains), anchored in PROV-O and FaBiO so the graph
composes with existing scholarly publishing infrastructure. The formal
schema lives in `ontology.ttl` alongside this guide.

For V10 MCP tool usage, see
[`packages/cli/skills/dkg-node/SKILL.md`](../../../../cli/skills/dkg-node/SKILL.md).
The tool surface to use against this ontology:

- `dkg_assertion_create` + `dkg_assertion_write` — populate (WM)
- `dkg_assertion_promote` — share with peers (SWM)
- `dkg_shared_memory_publish` — finalize on-chain (VM)
- `dkg_query` — SPARQL read; `dkg_memory_search` — free-text recall

The longer per-domain agent-guide walkthrough format will return when
the V10 ontology endpoint and per-project annotation workflow stabilise.
