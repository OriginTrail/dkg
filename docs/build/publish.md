---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Publish Knowledge

The default V10 write lifecycle is:

```text
Working Memory -> Shared Working Memory -> Verified Memory
```

Use Working Memory first when an agent is drafting or iterating. Promote to Shared Working Memory when peers should see it. Publish to Verified Memory only when the knowledge needs durable on-chain finality and the wallet has funds.

## CLI shape

```bash
dkg context-graph create my-project
dkg assertion import-file notes -f ./notes.md -c my-project
dkg assertion query notes -c my-project
dkg shared-memory publish my-project --name notes
```

Use `dkg assertion promote notes -c my-project` only when you want to stop at
Shared Working Memory without publishing to Verified Memory.

## Agent shape

Agents should use the Node Skill as the operational contract:

- `dkg_assertion_create`
- `dkg_assertion_write`
- `dkg_assertion_query`
- `dkg_assertion_promote`
- `dkg_shared_memory_publish`

Do not publish to Verified Memory just because data exists. Publishing spends gas/TRAC and should be an explicit finality choice.
