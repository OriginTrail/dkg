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
- Query the Knowledge Asset before sharing.
- Finalize (seal) the Knowledge Asset, then share it to SWM before publishing to VM (VM publish requires a finalized Knowledge Asset present in SWM).
- Check wallet funding before on-chain finality.

## Slow async share or publish, retryable `503`s

- A `503` with `retryable: true` from `share-async` or `publish-async` usually
  means the node is busy. Wait for the `Retry-After` header. If the body names a
  job (`jobId` or `existingJobId`), follow that job instead of resending. Resend
  a publish only if the answer says `jobCreated: false`; otherwise
  [find the job](../build/async-jobs.md#retry-safely) first. Never resend under a new name. What each answer means:
  [Async Share and Publish Jobs](../build/async-jobs.md).
- A `503` with `retryable: true` and code `CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE`
  means the node could not read a Context Graph's authority in time, usually
  because an RPC endpoint is slow. It refuses rather than guesses, and nothing was
  read or changed. The `dkg` CLI asks again by itself for reads and subscribes (and
  for a synchronous publish on `CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE`): up to four
  times, after 1, 2, 4 and 8 s, or the `Retry-After` when that is longer. A client
  of your own should do the same. If the answer stays, check the node's RPC
  endpoints.
- To see whether admission, the store or the workers are slow, read the
  `async_admission_usage` line in `dkg logs`. The daemon writes it every five
  minutes. How to read it: [Monitor Store and Queue Pressure](backpressure-observability.md).
- If jobs got slower after an update, check the start-up line
  `Store control path: ...`. To turn the path off, see
  [Store control path](async-queue-operations.md#store-control-path).

## Agent integrations

- MCP: restart the client after setup and inspect the tool list.
- Hermes: confirm the gateway is running and `API_SERVER_ENABLED=true`.
- OpenClaw: restart the gateway after setup if the adapter does not appear.
