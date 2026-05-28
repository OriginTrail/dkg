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
