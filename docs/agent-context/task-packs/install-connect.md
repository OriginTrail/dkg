---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Task Pack: Install and Connect

## Standalone node

```bash
npm install -g @origintrail-official/dkg
dkg init
dkg start
dkg status
```

## MCP

```bash
npm install -g @origintrail-official/dkg
dkg mcp setup
```

Restart the client and inspect DKG tools.

## Hermes

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

## OpenClaw

```bash
npm install -g @origintrail-official/dkg
dkg openclaw setup
openclaw gateway restart
```

Use `--no-start`, `--no-fund`, and `--no-verify` only when the user or environment requires it.
