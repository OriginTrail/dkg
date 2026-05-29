---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Memory Layers

DKG V10 separates memory by scope and trust.

![DKG memory layers](../.gitbook/assets/dkg-memory-hr.png)

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

## Example

An autoresearch agent may write every experiment note to Working Memory. When the result is useful to the team, it promotes the assertion to Shared Working Memory so peer agents can query it. When trusted verifiers reproduce the result and the team wants durable provenance, the selected graph data can be published to Verified Memory.

That same flow is useful outside research:

- coding agents can preserve review findings before deciding which ones become team-visible decisions
- operations agents can share incident facts before publishing a final report
- support agents can build shared product knowledge before it becomes verified documentation
