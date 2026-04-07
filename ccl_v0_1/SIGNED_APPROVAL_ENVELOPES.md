# Signed Approval Envelopes

This note sketches the long-term replacement for trusting raw ontology binding quads during CCL policy approval gossip.

## Goal

Make policy approval and revocation verifiable from a signed payload, not from trust in the sending peer.

## Envelope shape

Each approval or revocation should be broadcast with a detached, signed envelope containing:

- `type`: `ccl-policy-approval` or `ccl-policy-revocation`
- `paranetId`
- `policyUri`
- `policyName`
- `contextType` when scoped
- `bindingUri`
- `status`: `approved` or `revoked`
- `approvedAt` or `revokedAt`
- `actorDid`: expected paranet owner DID
- `chainId`
- `nonce` or monotonic sequence value
- `payloadHash`: hash of the canonical RDF quads being asserted
- `signature`

## Canonicalization

The signer should sign a canonical JSON payload, not raw RDF serialization. That avoids signature drift from harmless quad reordering.

Recommended canonical payload rules:

- UTF-8 JSON
- lexicographically sorted keys
- omit undefined fields
- timestamps in ISO-8601 UTC
- `payloadHash` derived from sorted canonical quads

## Verification flow

On gossip ingest, peers should:

1. parse the envelope
2. resolve the locally known paranet owner
3. ensure `actorDid` matches the current owner
4. recompute `payloadHash` from the incoming binding quads
5. verify the signature against the owner key
6. insert quads only if verification succeeds

If any step fails, reject the approval or revocation binding and log the reason.

## Keying options

Two realistic options:

- reuse the existing agent wallet signing key and bind it to the paranet owner DID
- introduce a dedicated approval-signing key referenced from the paranet profile

The first option is simpler for v0.x. The second is cleaner if approval authority needs rotation without changing the node identity key.

## Replay protection

Signed envelopes should include replay resistance. Acceptable options:

- `nonce` tracked per `(paranetId, contextType)`
- monotonic sequence number per binding scope
- chain-anchored version or block reference

Without replay protection, a revoked approval could be replayed later even if the signature is valid.

## Migration path

Short term:

- keep local owner-state validation on raw binding quads
- optionally attach unsigned envelope fields for observability

Next step:

- require a signed envelope for all new approval/revocation gossip
- continue reading legacy bindings locally, but reject unsigned peer gossip by default once the network is upgraded
