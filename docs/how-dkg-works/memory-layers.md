---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Memory Layers

DKG V10 separates memory by scope and trust.

| Layer | Scope | Cost | Use |
| --- | --- | --- | --- |
| Working Memory | Private to an agent/node | Free | Drafts, session notes, local imports. |
| Shared Working Memory | Visible to allowed peers | Free | Team-visible findings and shared context. |
| Verified Memory | On-chain anchored | Gas/TRAC | Durable final records and verifiable Knowledge Assets. |

The normal lifecycle is:

```text
create assertion -> write triples -> promote -> publish
```

Promotion moves data from WM to SWM. Publishing finalizes selected SWM data into VM. Publishing is not a normal save operation; it is a finality operation.
