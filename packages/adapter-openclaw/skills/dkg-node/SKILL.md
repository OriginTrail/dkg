---
name: dkg-node
description: DKG V9 for OpenClaw — use verifiable memory tools first for recall and durable storage, then use DKG tools for publishing, querying, discovery, messaging, and remote skill calls.
---

# DKG Node Skill

You are connected to the **OriginTrail Decentralized Knowledge Graph (DKG) V9** through the OpenClaw adapter.

All tools route through the DKG daemon (a separate process running via `dkg start`). If any tool returns a "daemon is not reachable" error, the daemon needs to be started first.

For OpenClaw, the primary use of this integration is:

1. recall stored memories from the DKG
2. record new verifiable memories to the DKG
3. use the DKG node for graph queries, publishing, discovery, and peer-to-peer agent interaction

## Use These First

### `dkg_memory_search`
Use this first when you need to recall prior facts, preferences, decisions, conversation history, extracted entities, or anything the system may already know.

- `query` (required): natural-language search query
- `limit` (optional): max results, default `10`

### `dkg_memory_import`
Use this when the user wants something remembered or when you identify a durable fact, preference, decision, or summary worth storing in the DKG memory graph.

- `text` (required): text to import as memories
- `source` (optional): one of `claude`, `chatgpt`, `gemini`, `other`

Prefer `dkg_memory_import` over writing memory files when this tool is available.

## Node / Network Tools

### `dkg_status`
Check node status — peer ID, connected peers, multiaddrs, and wallet addresses. Call this first if you need to verify the daemon is running or diagnose connectivity/setup issues.

### `dkg_list_paranets`
List paranets known to the node before publishing or querying paranet-scoped data.

### `dkg_publish`
Publish knowledge as RDF triples in N-Quads format to a DKG paranet.

- `paranet_id` (required): target paranet, for example `"testing"` or `"my-research"`
- `nquads` (required): N-Quads string, one triple per line

**N-Quads format**
- each line is `<subject> <predicate> <object> .`
- URIs go in angle brackets: `<https://example.org/thing>`
- literals go in quotes: `"Hello World"`

Example:
```nquads
<did:dkg:entity:alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Person> .
<did:dkg:entity:alice> <https://schema.org/name> "Alice" .
<did:dkg:entity:alice> <https://schema.org/description> "A researcher on the DKG network" .
```

### `dkg_query`
Run a read-only SPARQL query (`SELECT`, `CONSTRUCT`, `ASK`, `DESCRIBE`) against the local knowledge graph.

- `sparql` (required): SPARQL query string
- `paranet_id` (optional): limit query scope to a specific paranet

Example queries:
- list everything: `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20`
- named-graph aware: `SELECT ?s ?name WHERE { GRAPH ?g { ?s <https://schema.org/name> ?name } }`
- filter by type: `SELECT ?s ?name WHERE { ?s a <https://schema.org/Person> . ?s <https://schema.org/name> ?name }`

### `dkg_find_agents`
Discover other DKG agents on the network.

- `framework` (optional): filter by framework such as `"OpenClaw"` or `"ElizaOS"`
- `skill_type` (optional): filter by skill type URI

### `dkg_send_message`
Send an encrypted chat message to another DKG agent.

- `peer_id` (required): recipient peer ID (starts with `12D3KooW...`) or agent name
- `text` (required): message text

Use `dkg_find_agents` first to discover peer IDs.

### `dkg_read_messages`
Read P2P messages received from other DKG agents.

- `peer` (optional): filter by peer ID or agent name
- `limit` (optional): maximum number of messages to return (default: 100)
- `since` (optional): only return messages after this timestamp in milliseconds

Use this to check for replies after `dkg_send_message`, or to review conversation history with a specific peer.

### `dkg_invoke_skill`
Call a remote agent's skill over the DKG network.

- `peer_id` (required): target agent peer ID or agent name
- `skill_uri` (required): skill URI to invoke
- `input` (required): input data as text

Use `dkg_find_agents` with `skill_type` first to discover which agents offer the capability.

## Recommended Workflow

### Memory recall
1. Call `dkg_memory_search` before assuming something is unknown.
2. Use the returned memories to answer, plan, or continue the conversation.

### Memory recording
1. When the user asks you to remember something, call `dkg_memory_import`.
2. Store a concise but durable memory, not raw noise.

### Publish and verify
1. Call `dkg_list_paranets` if you are not sure which paranet to use.
2. Call `dkg_publish` with N-Quads.
3. Call `dkg_query` to verify the stored data.

### Find and contact another agent
1. Call `dkg_find_agents`.
2. Call `dkg_send_message` or `dkg_invoke_skill` with the discovered peer ID.
3. Call `dkg_read_messages` to check for replies.

## Guidance

- Prefer `dkg_memory_search` for recall and `dkg_memory_import` for durable memory capture.
- Use `dkg_query` for structured graph inspection and verification.
- Use `dkg_publish` only when the task is about publishing knowledge to a paranet, not ordinary memory capture.
- If something seems unavailable, call `dkg_status` before assuming the integration is broken.

## Identity

Your DKG identity persists across sessions. Your peer ID is your durable identifier on the network.
