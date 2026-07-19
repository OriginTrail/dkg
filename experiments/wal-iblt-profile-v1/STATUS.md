# WAL-005 experiment status

This file distinguishes the working laboratory slice from completion of the
full WAL-005 task.

## Implemented in the lab

- 32-byte-only set elements with duplicate rejection;
- requester/provider-role seed derivation and domain-separated BLAKE3 mapping
  and checksum hashes;
- the paper authors' rateless membership schedule with editable candidate
  constants;
- deterministic encoder, incremental decoder, signed subtraction, lowest-index
  peeling, direction classification, duplicate-output rejection, and checked
  i64 counts;
- exact zero-residual, provider count, and radix-Merkle root verification;
- 16-way set commitment with 256-ID leaves and high-nibble odd-prefix packing;
- strictly sorted/paginated fallback with exact count/root verification;
- canonical candidate CBOR symbol tuples with malformed/non-canonical input
  rejection;
- experimental vectors and a parameter/window sweep;
- 30 unit/property-style tests with 100% line, statement, function, and branch
  coverage for all current `src/` files.

## Still required before WAL-005 is complete

- 100,000-seed property/fuzz campaign and the full `N = 10^4`, `10^5`, and
  `10^6` workload matrix;
- bounded CPU, memory, elapsed-time, and symbol accounting with stable external
  reason codes;
- residual-core continuation tests that prove prior peel work survives every
  appended window;
- stale/wrong-seed, forged head, count/root mismatch, checksum-collision
  fixtures, and exhaustive malformed window/page schemas;
- exact signed-head binding and canonical CBOR request/response window schemas;
- incremental persistent set-commitment updates and restart serialization;
- cross-language vectors consumed byte-for-byte by two independent
  implementations;
- static repository checks proving control data has no content IDs,
  `WalObjectStore` admission, or independent synchronization lifecycle;
- benchmark comparison with full enumeration, fixed IBLT, and realistic
  transport RTT/loss/provider-switch conditions;
- RFC update that replaces candidate language with the selected exact values.

No RDF, SPARQL, SWM/VM reducer, discovery, libp2p, object-transfer, or
`WalObjectStore` code is imported by this experiment.
