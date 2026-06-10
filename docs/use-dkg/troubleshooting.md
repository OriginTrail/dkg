---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Troubleshooting

Start with the narrowest check that proves the failing layer.

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

401 means no usable token. 403 means the caller is recognized but not allowed to perform that operation.

## Memory writes

- Verify the target Context Graph exists.
- Verify the sub-graph exists before targeting it.
- Query the assertion before sharing.
- Finalize (seal) the assertion, then share it to SWM before publishing to VM (VM publish requires a finalized assertion present in SWM).
- Check wallet funding before on-chain finality.

## Agent integrations

- MCP: restart the client after setup and inspect the tool list.
- Hermes: confirm the gateway is running and `API_SERVER_ENABLED=true`.
- OpenClaw: restart the gateway after setup if the adapter does not appear.
