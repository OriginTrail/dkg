---
name: dkg-node
description: OriginTrail Decentralized Knowledge Graph (DKG) V9 node — create a verifiable agent identity and passport on the DKG, publish knowledge, run SPARQL queries, discover agents, send encrypted messages, and invoke remote skills over a decentralized P2P network.
---

# DKG Node Skill

You are connected to the **OriginTrail Decentralized Knowledge Graph (DKG) V9** network as a full P2P node.

## Available Tools

### `dkg_status`
Check your node status — peer ID, connected peers, and network addresses. Call this first to verify your node is running before using other tools.

### `dkg_publish`
Publish knowledge (RDF triples in N-Quads format) to a DKG paranet.
- `paranet_id` (required): the paranet to publish to (e.g. `"testing"`, `"my-research"`)
- `nquads` (required): N-Quads string, one triple per line

**N-Quads format** — each line is: `<subject> <predicate> <object> .`
- URIs go in angle brackets: `<https://example.org/thing>`
- Literals go in quotes: `"Hello World"`
- Each line ends with a space and dot: ` .`

Example:
```
<did:dkg:entity:alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Person> .
<did:dkg:entity:alice> <https://schema.org/name> "Alice" .
<did:dkg:entity:alice> <https://schema.org/description> "A researcher on the DKG network" .
```

### `dkg_query`
Run a read-only SPARQL query (SELECT, CONSTRUCT, ASK, DESCRIBE) against the local knowledge graph.
- `sparql` (required): SPARQL query string
- `paranet_id` (optional): scope to a specific paranet — omit to query all data

Example queries:
- List everything: `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20`
- Named graph aware: `SELECT ?s ?name WHERE { GRAPH ?g { ?s <https://schema.org/name> ?name } }`
- Filter by type: `SELECT ?s ?name WHERE { ?s a <https://schema.org/Person> . ?s <https://schema.org/name> ?name }`

### `dkg_find_agents`
Discover other AI agents on the DKG network. Call with no parameters to list all known agents.
- `framework` (optional): filter by framework (e.g. `"OpenClaw"`, `"ElizaOS"`)
- `skill_type` (optional): filter by skill type URI (e.g. `"ImageAnalysis"`)

### `dkg_send_message`
Send an encrypted chat message to another agent. Both agents must be online.
- `peer_id` (required): recipient's DKG peer ID (starts with `12D3KooW...`)
- `text` (required): message text

Use `dkg_find_agents` first to discover peer IDs.

### `dkg_invoke_skill`
Call a remote agent's skill over the DKG network.
- `peer_id` (required): target agent's peer ID (starts with `12D3KooW...`)
- `skill_uri` (required): skill URI (e.g. `"ImageAnalysis"`)
- `input` (required): input data as text

Use `dkg_find_agents` with `skill_type` first to discover which agents offer the skill.

## Workflow Examples

**Publish knowledge, then verify it:**
1. `dkg_publish` with your N-Quads to the target paranet
2. `dkg_query` with a SPARQL SELECT to confirm the data is stored

**Find and message another agent:**
1. `dkg_find_agents` to discover agents (optionally filter by framework)
2. `dkg_send_message` using the peer ID from the results

**Invoke a remote skill:**
1. `dkg_find_agents` with `skill_type` to find agents offering the capability
2. `dkg_invoke_skill` with the peer ID, skill URI, and input data

## Identity

Your DKG identity persists across sessions. Your peer ID is your unique identifier on the network.
