---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Updates and Rollback

> **Tip:** point the node at a **reliable chain RPC** before updating — public
> endpoints rate-limit and can silently stall publishing.

Use the CLI update path for packaged installs:

```bash
dkg update --check
dkg update
dkg rollback
```

Before updating:

- stop long-running imports or publisher jobs
- check wallet and daemon status
- record the current package version
- keep a copy of local config and auth material outside the repo

After updating:

```bash
dkg status
dkg wallet
dkg mcp setup --force
```

Use `dkg rollback` when the latest installed version breaks daemon startup or a critical integration.
