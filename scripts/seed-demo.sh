#!/usr/bin/env bash
set -euo pipefail

TOKEN="${1:?Usage: seed-demo.sh <auth-token>}"
API="http://127.0.0.1:9201"
CG="v10-design-session"

post() { curl -s -X POST "$API$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2"; }

echo "=== Creating context graph ==="
post /api/paranet/create "{\"id\":\"$CG\",\"name\":\"V10 Tri-Modal Memory Design\",\"description\":\"Design session between Branimir and Claude (Cursor) — architecting tri-modal memory for DKG V10: text, graph, and vector representations sharing a single UAL.\"}" | python3 -m json.tool 2>/dev/null || true

echo ""
echo "=== Seeding knowledge entities ==="
post /api/shared-memory/write "{
  \"contextGraphId\":\"$CG\",
  \"quads\":[
    {\"subject\":\"urn:entity:branimir\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/Person\",\"graph\":\"\"},
    {\"subject\":\"urn:entity:branimir\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Branimir\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:entity:branimir\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"DKG architect and project lead. Human participant in this design session.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:entity:claude-cursor\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/SoftwareApplication\",\"graph\":\"\"},
    {\"subject\":\"urn:entity:claude-cursor\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Claude\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:entity:claude-cursor\",\"predicate\":\"http://schema.org/additionalType\",\"object\":\"\\\"Cursor (Claude Opus)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:entity:claude-cursor\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"AI coding assistant in Cursor IDE. Implemented the tri-modal memory architecture.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:knowledge-asset\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:knowledge-asset\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Knowledge Asset (KA)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:knowledge-asset\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"On-chain representation of knowledge as an ERC-1155 token. In the tri-modal model, a KA combines three representations — markdown text, RDF triples, and vector embeddings — all sharing a single UAL.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:ual\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:ual\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Universal Asset Locator (UAL)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:ual\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Permanent on-chain identifier for a Knowledge Asset. Format: did:dkg:base:... The UAL is shared across all three modal representations.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:context-graph\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:context-graph\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Context Graph\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:context-graph\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Bounded knowledge space created on-chain. Agents join context graphs to share and discover knowledge. URIs are scoped to the CG to avoid naming collisions.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:wm\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:wm\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Working Memory (WM)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:wm\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Private agent memory. Stores drafts, personal notes, and private conversations. Only visible to the owning agent.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:swm\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:swm\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Shared Working Memory (SWM)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:swm\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Collaborative knowledge shared with project peers via gossipsub. Tentative facts that can be promoted to Verified Memory.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:vm\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:vm\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Verified Memory (VM)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:vm\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"On-chain, immutable knowledge. Published via the PUBLISH protocol with merkle root commitment. Publicly verifiable.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:sqlite-vec\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/SoftwareSourceCode\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:sqlite-vec\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"sqlite-vec (Vector Store V1)\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:sqlite-vec\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Embedded vector store using better-sqlite3. Stores float32 embeddings with brute-force cosine similarity. Zero config, good for <100K vectors. Upgrade path to pgvector.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:extraction-pipeline\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/SoftwareSourceCode\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:extraction-pipeline\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Markdown Extraction Pipeline\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:extraction-pipeline\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"MarkItDown converts files to markdown. markdown-extractor produces structural RDF triples. Optional LLM extractor adds semantic triples with schema.org types.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:uri-convention\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:uri-convention\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"CG-Scoped URI Convention\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:uri-convention\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Stable URIs for persistent concepts (cities, people, brands). Agent+timestamp URIs for transient items (conversation turns, events). Avoids collision retries with first-writer-wins.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:agent-onboarding\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/DefinedTerm\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:agent-onboarding\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Agent Onboarding\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:agent-onboarding\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"Agents discover and join projects via .dkg/config.yaml workspace configuration. Specifies context graph, DKG endpoint, and default memory layer.\\\"\",\"graph\":\"\"},

    {\"subject\":\"urn:concept:memory-explorer-ui\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/SoftwareApplication\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:memory-explorer-ui\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Memory Explorer UI\\\"\",\"graph\":\"\"},
    {\"subject\":\"urn:concept:memory-explorer-ui\",\"predicate\":\"http://schema.org/description\",\"object\":\"\\\"React-based project view with Timeline (conversation turns + dated events), Knowledge Assets (concepts, code, people), and Graph visualization. Trust indicated by colored left borders and status badges.\\\"\",\"graph\":\"\"}
  ]
}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  {d.get(\"triplesWritten\",d.get(\"error\"))} triples')"

echo ""
echo "=== Seeding conversation turns (real chat history) ==="

turn() {
  local n="$1"; shift
  local md="$1"
  post /api/memory/turn "{\"contextGraphId\":\"$CG\",\"markdown\":$(python3 -c "import json; print(json.dumps('''$md'''))"),\"layer\":\"swm\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Turn $n: {d.get(\"totalQuads\",0)} quads')"
  sleep 0.15
}

turn 1 '# Why not store memory as both text and graph?

When we work in "memory" mode — you and me specifically — it would make sense that our memory is stored both as text (copy paste) and graph. So why wouldn'"'"'t we have both stored all the time?

Each chat message could be an MD file perhaps? And the graph would be a set of rich extracted knowledge from that — an assertion — which would bidirectionally link to the file.

If you'"'"'re looking to "grep" — grep files. If you'"'"'re doing SPARQL, you have everything in the graph. If we add some vector DB (pgvector?), we can make vectors out of it all too. Whatcha think?'

turn 2 '# Tri-modal memory architecture proposal

The combination of all 3 representations should be what we consider a Knowledge Asset, and it should share 1 ID — a UAL.

Each conversation turn becomes one markdown file stored in the file store (content-addressed by keccak256). The existing markdown-extractor runs structural extraction to produce RDF triples. An optional LLM extractor enriches with schema.org typed entities. And we generate vector embeddings for similarity search.

Text for grep. Graph for SPARQL. Vectors for semantic similarity. All three share one UAL.'

turn 3 '# URI collisions in multi-agent scenarios

We'"'"'ve made it so that agents have "entity exclusivity" — they should reject if someone uses the same URI. But that means complexity: if they try to use a "taken" subject, they need to understand the error, then try another, until they succeed. Sounds inefficient.

My thinking is: agents should try to create unique (namespaced) URIs for transitory things (events, conversation turns), but more persistent URIs for long-term concepts (cities, people, brands).

The CG-scoped convention: `did:dkg:context-graph:{cgId}/turn/{agentPeerId}-{timestamp}` avoids the retry problem entirely.'

turn 4 '# What if you want to keep something private?

The interesting edge case is: what if you'"'"'re in a project but say something you want to keep private?

Why not keep it in Working Memory as private? It could stay there too. This makes more sense to me.

The memory layers naturally map to privacy:
- **WM** = private to the agent (drafts, personal notes)
- **SWM** = shared with project peers (collaborative knowledge)
- **VM** = on-chain, publicly verifiable (permanent record)

Some agent memory will always stay private — my conversations about certain things I want to keep private. I guess this is something I would specify during or at the beginning of our conversation.'

turn 5 '# How agents join a project

I consider Cursor one agent, and Claude another — and they would be working on the same project (context graph). So yes they would share, but I'"'"'d ask them to "join a project" — and joining could be "here'"'"'s which context graph it is and how to install the DKG", so agents can start using DKG by themselves.

When we'"'"'re part of a project (determined from a SKILL file or AGENTS.md in the project), that should be really shared.

I'"'"'d have a default "project" where, if I'"'"'m not part of other projects, all my memory of chats goes. That way you have a default memory, and if we decide we can create more.'

turn 6 '# Vector store: sqlite-vec now, pgvector later

For the vector store — perhaps this could be an upgrade path? Start with sqlite-vec: it'"'"'s embedded, zero-config, already uses better-sqlite3 which is in our project. Brute-force cosine similarity is fine for under 100K vectors.

How much "heavier" is pgvector? It needs a running PostgreSQL instance but gives HNSW indexes and sub-second similarity search at million-vector scale.

The VectorStore interface is backend-agnostic — when we outgrow sqlite-vec, swapping to pgvector is a config change, not a rewrite.'

turn 7 '# Implementation complete — endpoints live

POST /api/memory/turn is now live. It accepts markdown, stores it in the file store, runs structural extraction (+ optional LLM semantic extraction), writes quads to SWM or WM, and generates a vector embedding.

POST /api/memory/search fans out to vector similarity, SPARQL text match, and merges results with deduplication.

The Memory Explorer UI has Timeline (conversation turns interleaved with dated entities), Knowledge Assets (concepts, code, people grouped by type), and Graph visualization with trust-colored nodes.'

turn 8 '# UI refinements — making the explorer actually useful

Several rounds of feedback shaped the UI:
- Timeline should only show dated items — move concepts to Knowledge Assets tab
- Show full conversation text, not just metadata. Humanize speaker names (DID -> name), keep DID as tiny footer
- Replace the trust dot with a 4px colored left border + right-aligned status badge saying "Verified", "Shared", or "Private"
- Graph nodes 75% bigger, labels appear 2x sooner on zoom, 50% larger font
- Entities sorted by connection count (most connected first), then alphabetically
- Project home header: description, stats summary, participating agents with tool badges'

echo ""
echo "=== Done ==="
