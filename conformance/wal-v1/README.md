# WAL protocol v1 conformance

This private test package is the executable output of `WAL-001`. It freezes
language-neutral protocol bytes without creating the production `packages/wal`
runtime owned by `WAL-002` and later implementation tasks.

`WalObjectV1` is the sole durable content-addressed synchronization atom. The
fixtures contain no payload, blob, chunk, range, IBLT-symbol, or commitment-node
content identity. All DKG, RDF, SWM, VM, policy, tier, chain, and conflict data
is encoded by the adapter inside the opaque inline `payloadBytes` field.

Two independent TypeScript implementations consume the same JSON fixtures:

- `src/reference.ts` is a generic deterministic-CBOR and protocol reference;
- `src/independent.ts` is a separately written cursor-based reader and
  schema-specific verifier.

Neither implementation is production code. Downstream tasks must consume the
checked-in vectors and are not permitted to import this package at runtime.

Run:

```sh
pnpm --filter @origintrail-official/dkg-wal-v1-conformance verify
```

Experimental reconciliation window sizes and fallback thresholds do not live
here. They remain in the WAL-005 experiment directory. The symbol-membership
schedule, exact IEEE-754 binary64 arithmetic, hashing domains, and wire bytes
are normative. No floating-point value is serialized: binary64 is used only
to derive deterministic symbol membership indices.
