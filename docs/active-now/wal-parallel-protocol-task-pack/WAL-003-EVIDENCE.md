# WAL-003 implementation evidence

## Outcome

WAL-003 implements the production canonical-byte, signing, and identity layer
for OT-RFC-65 protocol version 1 in `packages/wal/src/protocol/`. It consumes
the WAL-001 frozen schema and language-neutral vectors without adding another
implementation language or introducing JSON as a protocol representation.

The change is additive to the isolated WAL package. It does not register a
network protocol, write RDF, change graph synchronization, select DKG
authority, or modify SWM, SVM/verified-memory, Sender Key, chain-finality, or
reorg behavior. Legacy remains authoritative and `parallel` remains shadow-only
under the WAL-002 runtime gate.

## Canonical byte contract

- `canonical-cbor.ts` accepts only the RFC 8949 profile frozen in Section 4:
  definite arrays/text/bytes, shortest integers, fatal UTF-8, NFC text, and the
  exact supported boolean/null values. Maps, tags, floats, undefined/simple
  values, indefinite forms, non-shortest arguments, unsafe lengths, truncated
  input, and trailing bytes fail with stable `WAL_CBOR_*` codes.
- `schema.ts` is the production typed registry for every WAL-001 tuple. A test
  compares every tuple name, field position, field type, and hash domain with
  `protocol-v1.schema.json`, then round-trips one valid value for every tuple.
- `codec.ts` enforces exact arity, explicit null positions, fixed byte widths,
  integer ranges, canonical set ordering/uniqueness, keyed uniqueness, and the
  `WalObjectV1` sequence/previous-object rule in both signed and unsigned forms.
- `wal-object.ts` exposes one exact eight-position `WalObjectV1` and one
  seven-position unsigned form. `payloadBytes` remains inline and opaque; there
  is no payload, blob, range, or chunk identity in the production schema.

## Cryptographic and authority boundary

- BLAKE3 signature digests and complete signed-object IDs use the exact frozen
  domain strings for WAL objects, author checkpoints, membership checkpoints,
  collection vectors, authority sets, receipts, bootstrap manifests, rollback
  recovery, and network cutover.
- Signatures are EIP-191 secp256k1 signatures over the 32-byte protocol digest.
  Verification requires 65 bytes, normalized recovery value 27/28, nonzero
  in-range `r`, canonical nonzero low-S, successful public-key recovery, and an
  exact recovered-address match.
- The signer adapter directly accepts Ethers-style `getAddress()` signers, the
  repository publisher shape of `address` plus `signMessage()`, and the EVM
  adapter shape of `getSignerAddress()` plus compact EIP-2098 `{r, vs}` output.
  Tests exercise all three shapes against the same golden signature.
- Threshold verification is deliberately policy-neutral: the caller supplies
  the currently authorized addresses and threshold. Duplicate, unauthorized,
  mismatched, insufficient, zero, or unattainable authority inputs fail closed.
  WAL-003 therefore verifies existing DKG authority rather than redefining it.

## Acceptance mapping

1. Production tests reproduce the frozen `WalObjectV1` unsigned bytes,
   signature digest, signature, signed canonical bytes, recovered writer, and
   `WalObjectId`; they also reproduce checkpoint, membership, vector, authority,
   cutover, namespace, and collection identities.
2. All checked-in invalid WAL-object fixtures and direct malformed-CBOR cases
   reject. Tests cover maps, tags, floats/simple values, indefinite lengths,
   non-shortest integers/lengths, truncation, trailing bytes, invalid UTF-8,
   non-NFC text, wrong arity, missing/extra positions, widths, bounds, ordering,
   duplicates, sequence links, signature malleability, and domain confusion.
3. A deterministic 1,000-case property loop proves decode/re-encode byte
   identity for accepted values. The two independent TypeScript WAL-001
   consumers continue to pass the complete language-neutral fixture set.
4. The WAL package exports the implementation at both the package root and
   `@origintrail-official/dkg-wal/protocol`. There is no runtime dependency on
   the conformance harness.
5. Package coverage remains at 100% statements, branches, functions, and lines,
   including the existing runtime and WAL-005 reconciliation modules.

## Validation receipts

```text
pnpm --filter @origintrail-official/dkg-wal build
  PASS

pnpm --filter @origintrail-official/dkg-wal lint
  PASS: production and test TypeScript static check

pnpm --filter @origintrail-official/dkg-wal test:coverage
  PASS: 14 files passed, 1 explicit scale file skipped
  PASS: 173 tests, 2 explicit scale tests skipped
  PASS: 100% statements, branches, functions, and lines

pnpm --filter @origintrail-official/dkg-wal test:conformance
  PASS: generated fixture checksum comparison
  PASS: 2 conformance files, 41 tests
  PASS: both independently written TypeScript consumers and typecheck
```

The explicit stress and large-scale reconciliation/benchmark receipts remain
owned by WAL-005 and are not rerun as proof of this byte-identity-only task.
