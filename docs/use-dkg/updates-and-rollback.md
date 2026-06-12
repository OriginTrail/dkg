---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Updates and Rollback

> **⚠️ Upgrading from rc.16 (or earlier) to rc.17?** rc.17 is an *off-chain*
> breaking change (new per-KA store layout) with **no automatic wipe** — a plain
> `dkg update` leaves the node running rc.17 over old-layout data, which causes a
> sluggish / CPU-bound node and publish failures. Do the **one-time store wipe**
> as part of the update: follow [**Upgrading to rc.17 — land it clean**](../UPGRADE_TO_RC17.md).
> Also point the node at a **reliable chain RPC** — public endpoints rate-limit
> and silently stall publishing.

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
