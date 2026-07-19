# WAL-005 implementation status

The reconciliation implementation has been promoted to `packages/wal`; this
directory now contains only candidate configurations, the sweep, and retained
experiment notes.

## Implemented and verified

- exact 32-byte `WalObjectId` reconciliation boundary;
- deterministic rateless encoder, incremental decoder, signed subtraction,
  lowest-index peel, direction classification, and checked i64 counts;
- canonical deterministic CBOR symbol tuples and stable error codes;
- exact head-bound count/root acceptance and sorted paginated fallback;
- incremental 16-way radix commitment with 256-ID leaves and restart snapshots;
- symbol, decoded-ID, operation, memory, and elapsed-time budgets;
- 100% statement, branch, function, and line coverage;
- whole-object E2E synchronization and empty-receiver backfill;
- 100,000 deterministic seed cases and N=10k/100k/1M at fixed k=32;
- TypeScript and independent Go conformance consumers;
- tracked fresh-process 10k/100k/1M/10M encoded-byte and timing baseline,
  rotated repetitions, summary distributions, and regression gate;
- static proof that the reconciliation source imports no RDF, SPARQL, network,
  object-payload, or DKG semantic layer.

## Remaining outside WAL-005

- integrate discovery, request/response frames, cancellation, and provider
  selection in the parallel network protocol;
- connect missing IDs to the complete-`WalObjectV1` transfer/store path;
- keep signed-head authentication and replay protection at the protocol layer;
- run wider RTT/loss/adversarial workload sweeps before freezing candidate
  window and fallback policy values;
- implement the downstream SPARQL conflict adapter without moving semantic
  behavior into byte-level reconciliation.
