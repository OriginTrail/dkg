# WAL-013 shadow-write benchmark

This fresh-process A/B harness compares the existing production-authoritative
local share path with the same path plus the real WAL-013 durable shadow writer.
It alternates arm order and uses identical operations, Oxigraph storage, signer,
and durability configuration. The WAL arm signs and stores one complete
`WalObjectV1` plus one author checkpoint per successful operation.

Use the repository's Node 24 runtime (the native `better-sqlite3` ABI must
match) and run the local durability-floor gate with at least three repetitions:

```bash
node --import tsx packages/agent/scripts/wal-shadow-write-benchmark.ts \
  --operations=250 \
  --warmup=25 \
  --quads-per-operation=100 \
  --repetitions=3 \
  --check \
  --output=/tmp/dkg-wal-013-shadow-write.json
```

The report contains pooled median/p95/p99 operation latency, median CPU seconds,
peak RSS, RSS increase, graph-operation counts, durable object/checkpoint counts,
per-run raw samples, and the RFC gates. Generated receipts stay outside the
repository; the task evidence records their digest and environment.

This harness deliberately excludes curator/network confirmation, so it measures
the worst relative floor where the current arm is only an in-process Oxigraph
write. Its `--check` result is a diagnostic lower-bound, not by itself the
WAL-013 end-to-end release decision. The normative latency gate must also run
against the same functioning network-confirmed publish/share profile used by
WAL-000. Do not add artificial delay to this arm or use a broken current-sync
run as the baseline.
