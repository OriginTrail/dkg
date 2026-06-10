# ADR 0004 - Private store triples are plaintext RDF after message decryption

- **Status**: Accepted
- **Date**: 2026-05-26
- **Related issues**: [#633](https://github.com/OriginTrail/dkg/issues/633),
  [#644](https://github.com/OriginTrail/dkg/pull/644)

## Context

Private context graph data is protected by graph placement, access policy, and
encrypted node-to-node transport, not by encrypting RDF terms inside the local
triple store. When a node receives an encrypted SWM/private payload, it must
decrypt the message at the transport/workspace boundary, validate the request,
and insert normal plaintext RDF terms into `_private` or `_shared_memory` so
SPARQL can query literals, IRIs, blank nodes, and filterable EPCIS-style fields.

## Decision

This replaces the `PrivateContentStore` `enc:gcm:v1` at-rest seal that encrypted
private literal object terms and made object-value filters fail
(OriginTrail/dkg#633). We will not migrate legacy encrypted `_private` rows; this
is test/devnet-phase data and can remain as legacy state or be overwritten by
recapture. The scoped fix removes private-store encryption/decryption and
`DKG_PRIVATE_STORE_KEY*` configuration while preserving Sender Key SWM, legacy
`EncryptedWorkspacePayload`, and other peer-message encryption.

## Consequences

Encrypted ACK staging is a separate publish-finalization exception: non-member
core nodes may temporarily store opaque ciphertext bytes for storage ACK purposes
under the staging path, because they are not allowed to see curated plaintext.
That exception is out of scope for the #633 fix and should be revisited
separately if ciphertext blob staging needs to move out of RDF storage.
