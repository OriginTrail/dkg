---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Task Pack: Operate and Troubleshoot

Start with the failing layer.

## Daemon

```bash
dkg status
dkg logs
curl http://127.0.0.1:9200/api/status
```

## Auth

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agent/identity
```

## Funds

```bash
dkg wallet
```

Funds are needed for Verifiable Memory, not for WM/SWM/query-only flows.

## Connectivity

```bash
dkg peers
dkg peer info <peer-id>
```

For MCP, restart the client after setup. For Hermes, confirm the gateway is running. For OpenClaw, restart the gateway if the adapter is not loaded.
