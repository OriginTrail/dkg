---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Universal Messenger

>
>
> ```mermaid
> sequenceDiagram
>     autonumber
>
>     participant SApp as Sender App
>     participant SMS as Sender Messenger
>     participant SIdem as Sender Idem
>     participant SLib as Sender libp2p
>     participant Relay as Relay R - one of N reserved
>     participant RLib as Receiver libp2p
>     participant RMS as Receiver Messenger
>     participant RIdem as Receiver Idem
>     participant RApp as Receiver App
>
>     Note over Relay: Sees Noise/TLS-encrypted frames only<br>ReliableEnvelope is opaque to relay
>
>     SApp->>SMS: sendReliable(receiverPid, "/dkg/10.0.1/X", payload)
>     SMS->>SMS: messageId = uuid()
>     SMS->>SIdem: check(receiverPid, X, messageId, "out")
>     SIdem-->>SMS: seen = false
>     SMS->>SMS: env = ReliableEnvelope.encode(messageId, v, tsMs, payload)
>     SMS->>SLib: ProtocolRouter.send via relay circuit
>     SLib->>Relay: open circuit-relay-v2 stream
>     Relay->>RLib: forward bytes without inspection
>     RLib->>RMS: deliver to Messenger.register wrapper for X
>     RMS->>RMS: env = ReliableEnvelope.decode(bytes)
>     RMS->>RIdem: check(senderPid, X, env.messageId, "in")
>
>     alt duplicate receive, for example multi-path race
>         RIdem-->>RMS: seen = true, cachedResponse
>         RMS-->>RLib: respond with cached response or RESPONSE_GONE
>     else first receive
>         RIdem-->>RMS: seen = false
>         RMS->>RApp: handler(env.payload, senderPid)
>         RApp-->>RMS: responseBytes
>         RMS->>RIdem: record(senderPid, X, messageId, "in", responseBytes)
>         RMS-->>RLib: respond(responseBytes)
>     end
>
>     RLib->>Relay: response bytes
>     Relay->>SLib: forward response bytes
>     SLib->>SMS: response
>     SMS->>SIdem: record(receiverPid, X, messageId, "out", response)
>     SMS-->>SApp: delivered = true, response, messageId, attempts = 1
> ```


## Outbox retry limits

Automatic retries admit one page at a time, bounded by both entry count and encoded-envelope bytes. The default page holds at most 100 entries and 4 MiB of payloads, with four retry workers. SQLite selects metadata first and loads only the payloads admitted to that page. The byte limit covers retained envelope payloads; it does not include database caches, transport buffers, or the process's other memory.

Operators can set `messengerOutboxDrain` in the node configuration and restart the daemon:

```json
{
  "messengerOutboxDrain": {
    "batchSize": 100,
    "maxPayloadBytes": 4194304,
    "concurrency": 4
  }
}
```

The SDK accepts the same `messengerOutboxDrain` field in `DKGAgent.create`. Every supplied value must be a positive safe integer; invalid values fail startup. An envelope larger than `maxPayloadBytes` stays queued and is skipped without loading its payload, so smaller due messages can proceed. Increase the configured budget to admit it on a later run, or let the normal outbox expiry remove it. Among eligible messages, retries preserve `nextAttemptAt`, then `firstFailureAt`, then binary UTF-8 peer/protocol/message-ID order. A page stops before the next eligible message would exceed its remaining bytes; later retries advance after earlier messages are delivered or rescheduled.

`GET /api/slo` exposes an `outbox` object with queued entry/byte counts, active claimed entry/byte counts, the last page's size, oldest overdue age, an oversized-due gauge, and cumulative oversized-skip and byte-deferral counters. Skip counts record observations per page, so the same oversized message can increment the counter again on a later tick. These fields have no peer or protocol labels. `getMessengerOutboxStats()` exposes the same snapshot to SDK callers.

Summary diagnostics and automatic expiry read metadata without loading payload BLOBs. `Messenger.listOutbox()` returns retry metadata plus `payloadBytes`; callers that need envelopes must explicitly call `listOutbox({ includePayload: true })`. `DKGAgent.listMessageOutbox()` returns metadata for the chat protocol.

Custom stores used by Messenger must implement the `BoundedProtocolOutboxStore` capabilities: `readDuePage`, `listMetadata`, `dropExpiredMetadata`, `recordRetryFailure`, and `queueStats`. Enforce the count and byte budgets inside storage before materializing payloads. A legacy store lacking these methods is rejected when Messenger is constructed; automatic retries never fall back to unbounded `due()` or `list()` reads. Explicit legacy payload-inspection methods remain available on `ProtocolOutbox`.

Each durable outbox has one Messenger owner. Pages do not remove or lease database rows: rows remain durable across a crash until successful delivery or expiry, while per-entry in-process guards and receiver idempotency protect retries. Sharing one store between independent Messenger consumers requires a separate durable lease protocol and is outside this contract.
