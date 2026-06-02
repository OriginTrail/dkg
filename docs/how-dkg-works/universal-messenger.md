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
