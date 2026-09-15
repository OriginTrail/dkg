# Storage amplification benchmark

`bench/storage-amplification.mjs` provides a deterministic disk-sizing matrix for
the embedded persisted Oxigraph store. It compares repeated vocabulary with
unique predicates and literals across WM, SWM, context projection, VM, and
lifecycle stages.

Run it with:

```sh
pnpm bench:storage-amplification
```

The default matrix uses 100, 1,000, and 5,000 retained assets. Use
`DKG_BENCH_AMPLIFICATION_SIZES=100,1000,10000` to select another bounded set
(maximum 100,000 per scenario). The command emits JSON containing logical
triples, unique terms, persisted bytes, transient snapshot overlap, cumulative
flush bytes, write amplification, restart recovery, and bytes per retained
asset. Each scenario also reports `compactionRecovery` for the verified
close/reopen canonical snapshot rewrite. Set
`DKG_BENCH_AMPLIFICATION_SETTLE_MS` to change the post-reopen settle period
(default 100 ms, maximum 60 s).

The benchmark uses a disposable directory and never starts the agent,
reconciliation workers, or a network peer. It asserts that the only file left
after each flush is the persisted `store.nq`, so reconciliation cannot
contaminate the measurements. `steadyStateBytes` is the post-close, reopen,
flush, and settle snapshot. This close/reopen flush is the adapter's canonical
snapshot rewrite; the embedded adapter has no separate storage-engine compactor.
`transientPeakBytes` accounts for the old and new snapshots coexisting during
the adapter's atomic replacement; directory metadata is not included.

Use the observed bytes-per-retained-asset range for the vocabulary/cardinality
mix closest to the deployment, then add headroom for concurrent snapshots and
backups. The output is capacity evidence for this local Oxigraph persistence
implementation, not a claim about remote Blazegraph or filesystem-specific
compaction behavior.
