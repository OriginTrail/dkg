---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Knowledge Assets

A Knowledge Asset is published graph data with provenance and integrity. It packages RDF statements so other nodes can verify who published them, what was published, and whether the content still matches its commitment.

Use Knowledge Assets when knowledge needs to survive beyond local or team memory:

- facts that must be independently verifiable
- records that should have a durable identifier
- data that another party may endorse or verify
- final outputs from a multi-agent workflow

Agents should not convert every note into a Knowledge Asset. Most work starts in Working Memory and becomes a Knowledge Asset only after it is worth finalizing.

## Knowledge Collections and UALs

A Knowledge Collection groups one or more Knowledge Assets into a single publish operation. After publication, each durable asset can be addressed through a UAL.

Use the UAL when another workflow needs to cite, fetch, or verify published knowledge. Use the Context Graph when the workflow needs the larger scoped memory domain around that asset.

## Publisher Authority

Publishing records who finalized the knowledge. When a Publishing Conviction Account is active, a registered publishing agent can use that account's conviction path. If the agent is not registered or the account is not eligible for the publish, the publisher path falls back to direct spend.
