# Candidate `ProtocolV1IbltReconciliationAlgorithm`

Status: **implemented and interoperable; tuning values remain reviewable**

Baseline candidate: `paper-baseline-v0`

## Frozen architecture invariants

1. The reconciled set element is exactly one 32-byte `WalObjectId`.
2. Only a complete canonical `WalObjectV1` is durable synchronized content.
3. IBLT symbols, pages, roots, nodes, and peel state are disposable control or
   local data and never content-addressed atoms.
4. Provider-minus-receiver counts are checked signed i64 values; ID and
   checksum accumulators are 32-byte XOR sums.
5. A non-zero cell is pure only at count `+1` or `-1` and when its
   domain-separated checksum matches `idXor`.
6. Provider symbols are consumed in contiguous order and appended windows
   retain all prior residual and peel work.
7. Peeling always chooses the lowest currently decodable symbol index.
8. Decode output is accepted only after uniqueness, bounds, complete residual
   decode, and reconstruction of the provider head's exact count and root.
9. Fallback IDs are strictly sorted, paginated, bound to one head, and accepted
   only after exact count/root verification.

## Seed and checksum derivation

```text
reconciliationSeed = BLAKE3(
  "dkg-wal-iblt-seed-v1\0" ||
  requesterHeadId || providerHeadId || requesterNonce
)

mappingSeed = u64le(first8(BLAKE3(
  "dkg-wal-iblt-map-v1\0" || reconciliationSeed || walObjectId
)))

idChecksum = BLAKE3(
  "dkg-wal-iblt-check-v1\0" || reconciliationSeed || walObjectId
)
```

The requester chooses a fresh nonce after authenticating the provider's
immutable signed head. The surrounding protocol must not reuse a seed under a
different head or requester/provider role ordering.

## Rateless membership schedule

Every ID belongs to symbol zero. Starting with `state = mappingSeed` and
`index = 0`, later indices are:

```text
state = state * 0xda942042e4dd58b5 mod 2^64
distance = max(1, ceil(
  (index + 1.5) * (2^32 / sqrt(binary64(state + 1)) - 1)
))
index = index + distance
```

The two separately written TypeScript conformance consumers agree on checked-in
mapping indices, symbols, decode output, roots, and pages. Alternative mapping
values must be added as named configs and must produce new versioned vectors;
they must never silently change an existing protocol profile.

`integer-only-v1-candidate` is such an alternative. It replaces binary64
square root and rounding with exact `isqrt`, fixed-point division, and integer
ceiling while leaving the atom, symbol tuple, seed, checksum, and peel rules
unchanged. It remains an experiment and does not silently redefine the
benchmarked `paper-baseline-v0`; see `RESULTS.md` for the rotated A/B.

## Canonical symbol tuple

Each symbol is deterministic CBOR:

```text
[symbolIndex, signedCount, idXor, checksumXor]
```

- exactly four array items;
- shortest-form deterministic integers;
- non-negative bounded `symbolIndex` and signed-i64 `signedCount`;
- two definite-length 32-byte strings encoded with `58 20`;
- no indefinite values, wrong arity/type/length, overflow, truncation, or
  trailing bytes.

## Tunable policy values

| Value | Baseline | Classification |
|---|---:|---|
| Initial window | 32 symbols | transport policy candidate |
| Window growth | 2x | transport policy candidate |
| Maximum symbols | 1,048,576 | safety limit |
| Maximum decoded difference | 250,000 IDs | safety/admission limit |
| Maximum operations | 1,000,000,000 | safety limit |
| Maximum accounted memory | 512 MiB | safety limit |
| Maximum elapsed time | 120 s | safety limit |
| Maximum overhead ratio | 2.5x | fallback policy candidate |
| Empty receiver | enumerate | explicit backfill policy |

The JSON under `configs/` is the editable experiment record. Every retained
sweep must name its full config and source revision. Changing a safety or
transport value does not create a smaller synchronization atom: the atom is
always the complete `WalObjectV1`.

## Verification gate

The production candidate in `packages/wal` currently satisfies the WAL-005
implementation gate:

- 100% source coverage with malformed/adversarial/resource cases;
- 100,000 deterministic reconciliation seeds;
- fixed `k=32` at N=10k, 100k, and 1M;
- incremental commitment insertion/deletion/restart;
- head-bound backfill and whole-object E2E transfer;
- two independent TypeScript vector consumers;
- static semantic/network/object-payload boundary checks; and
- isolated sorted-stream benchmarks at N=10k, 100k, 1M, and 10M with raw phase
  timings, rotated repetitions, summary distributions, memory telemetry, and a
  tracked regression threshold.

Broader RTT, loss, provider-switch, and real workload measurements can still
select better window/fallback values before a network protocol version is
declared wire-stable. Those experiments belong here and reuse the single
production implementation.
