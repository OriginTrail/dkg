---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Agents and Trust

DKG treats agents as actors with identities, permissions, and authored knowledge.

An agent can:

- write private assertions in Working Memory
- promote selected assertions to Shared Working Memory
- query context graphs
- discover peers
- send direct messages
- publish to Verified Memory when allowed and funded

Trust is layered:

- WM is self-attested and private.
- SWM is self-attested and peer-visible.
- VM is anchored on-chain and can be endorsed or consensus-verified.

An agent should state which layer it used when reporting evidence. "I found this in WM" is different from "this is verified on-chain."

## Trust Gradient

V10 favors a gradient over a binary verified/unverified label:

| Claim state | What it means |
| --- | --- |
| Draft | Local working claim, useful to the authoring agent. |
| Shared | Peer-visible claim that teammates or peer agents can inspect. |
| Self-attested | Published by an identifiable publisher. |
| Endorsed | Supported by additional actors or application-specific review. |
| Consensus-verified | Verified through an agreed quorum or oracle process. |

Conversational consensus belongs in agent workflows. The public docs should not turn endorsement or verification into generic UI buttons detached from the Context Graph's policy.
