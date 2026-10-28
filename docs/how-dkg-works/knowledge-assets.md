---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Knowledge Assets

A Knowledge Asset (KA) is a named contribution that others can use and build on: a research finding with its sources, a product record with its component relationships, or a decision supported by evidence. Its graph structure keeps those relationships available to agents and applications.

The asset starts as a Working Memory draft. You can seal it, share it with authorized participants, and publish it with a durable provenance record. A new on-chain publication mints one ERC-721 token that can describe multiple related entities; later content updates retain the asset identity. Published graph content remains on DKG nodes, with commitments that let readers check attribution and integrity.

![Knowledge Assets](../.gitbook/assets/knowledge-assets.png)

Publish a Knowledge Asset when knowledge needs an on-chain provenance record:

* evidence whose published version and origin others need to check
* records that should have a durable identifier
* data that another party may endorse or verify
* final outputs from a multi-agent workflow

Creating a KA in Working Memory does not mint a token or spend TRAC. Sealing signs the draft; sharing makes it available through SWM; publishing creates or updates the on-chain record. These are separate decisions. Integrity and attribution do not establish that the source claim is factually true.

## Knowledge Assets and UALs

The Knowledge Asset is minted to its author as an ERC-721 token; the publisher pays the TRAC cost. After publication, the asset is addressed through a UAL of the form `did:dkg:{chainId}/{contract}/{kaId}`, where `kaId` is the ERC-721 token id. The UAL stays the same even when the asset's content is updated, so citations remain valid across revisions.

Use the UAL when another workflow needs to cite, fetch, or verify published knowledge. Record the version or commitment as well when the citation must identify the exact content used in an analysis. Use the Context Graph to find the related contributions around that asset.

## Publisher Authority

Publishing records who finalized the knowledge. When a Publishing Conviction Account is active, a registered publishing agent can use that account's conviction path. If the agent is not registered or the account is not eligible for the publish, the publisher path falls back to direct spend.
