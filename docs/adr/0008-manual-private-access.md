# ADR 0008: explicit receiver-side private access

Status: accepted

Issue: [#409](https://github.com/OriginTrail/dkg/issues/409)

## Context

A publisher can authorize another physical peer with a KA `allowList`, and its
AccessHandler enforces that policy. Receivers previously had no agent or daemon
entry point that called the existing AccessClient. Permission alone therefore
did not provide a usable receiver-side fetch.

## Decision

Choose issue #409 option B: the node operator explicitly requests private
content with `POST /api/access/request`, or `agent.requestPrivateAccess` in the
SDK. The publisher still authorizes the authenticated transport peer. An
agent-scoped HTTP token cannot exercise the node's peer identity. This follows
the existing node-admin policy; disabling daemon authentication also disables
that HTTP authorization gate.

The HTTP request contains exactly `publisherPeerId` and `kaUal`. The peer ID must
be valid, and the UAL must use the current deterministic V10 KA format. Payment
proofs and legacy UAL conversion are outside this endpoint's contract.

```sh
curl -X POST http://127.0.0.1:9200/api/access/request \
  -H "Authorization: Bearer $DKG_NODE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"publisherPeerId":"<publisher peer ID>","kaUal":"did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0"}'
```

A successful response contains `granted`, `quads`, the peer-supplied
`privateMerkleRoot` as hex, `storedInGraph: false`, and:

```json
{"verification":{"kind":"peer-root-self-check","matches":true,"chainAnchored":false}}
```

`matches` means only that the returned quads match the root supplied by the
same peer. It does **not** verify a locally trusted or on-chain commitment,
assertion freshness, or the publisher's authorship. A malicious peer can return
a different but self-consistent payload. Applications needing anchored evidence
must verify that commitment independently. A missing or mismatched root fails
closed, without returning the unverified quads.

Direct `AccessClient` calls with cancellation or response-limit options require
an explicit `sendRequestOwned` transport method (the standard Messenger provides
it). Legacy adapters exposing only `sendReliable` retain optionless behavior;
bounded calls fail before sending instead of silently dropping ownership. The
client also settles caller cancellation even if a transport ignores its signal.

The operation returns content to its caller and does not insert it into any RDF
partition. It promises neither automatic delivery nor EPCIS/local-query parity.
Existing Messenger idempotency handling may retain response bytes under its
normal cache policy; `storedInGraph: false` is not a promise of no transport
storage. Adding durable graph admission would require a separate design that
binds the content to authenticated local commitments and versions.

## Bounds and lifetime

Only one manual request runs per node at a time. It has a 30-second deadline,
ends on caller disconnect or node shutdown, accepts at most 1 MiB of response
bytes and 10,000 quads, and caps HTTP JSON output at 2 MiB. These are ceilings,
not an assertion that every peer can serve payloads of that size. Reliable wire
framing is retained, but this read never enters the durable outbox and does not
start a post-failure discovery job. The caller can retry explicitly.

The daemon uses 403 for peer denial, 400 for malformed input, 413 for an oversized
decoded/JSON response, 429 for an overlapping request, 502 for a failed peer-root
self-check, 504 for the deadline, and 503 for other transport/unavailability
failures. Peer error text is not copied into HTTP errors.

## Verification

Regression coverage includes real allowed and denied local peers, tampered and
rootless responses, response bounds, deadline/node-stop/caller cancellation,
no durable retry, and operator HTTP authorization. The real-peer test uses only
an owned loopback bootstrap and does not discover other local nodes.
