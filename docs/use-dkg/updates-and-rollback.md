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

## Node.js security releases

Node.js 22.23.4, 24.22.1 and 26.12.1, released on 21 October 2026, fix
CVE-2026-111497, an out-of-bounds write in the Brotli decoder that Node.js
bundles. Upgrade Node.js on every host that runs a node to one of these
releases or a later one on the same line. The 23 and 25 lines get no fix:
move to 22, 24 or 26. A running node keeps the Node.js it started with, so
restart it after the upgrade.

On a host that installs Node.js from NodeSource packages:

```bash
node --version
sudo apt-get update && sudo apt-get install --only-upgrade nodejs
node --version
```

Then restart the node: `dkg stop` and `dkg start`, or restart the service that
runs it. `dkg status` shows the Node.js release the running daemon uses on its
`Runtime:` line.

From 10.0.26 a node also refuses Brotli-encoded responses on its outbound HTTP
requests. That is defence in depth and does not replace the upgrade.
