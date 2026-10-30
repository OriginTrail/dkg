# Uncached Blazegraph graph-prefix evaluation (#3270)

The native candidate returns fewer bytes, but its admitted query time regresses
on this local backend. **Keep the existing fresh full enumeration in production.**
This PR adds an executable candidate, differential tests, and a repeatable local
benchmark; it does not claim a production latency fix or solve queue saturation.

## Reproduce

Build storage with Node 22 and pnpm, start an owned local Blazegraph server, then:

```sh
BLAZEGRAPH_TEST_URL=http://127.0.0.1:9999/bigdata/namespace/kb/sparql \
  node packages/storage/scripts/blazegraph-prefix-benchmark.mjs
BLAZEGRAPH_TEST_URL=http://127.0.0.1:9999/bigdata/namespace/kb/sparql \
  pnpm --filter @origintrail-official/dkg-storage exec vitest run \
  test/blazegraph-prefix.test.ts test/blazegraph-prefix.integration.test.ts
BLAZEGRAPH_TEST_URL=http://127.0.0.1:9999/bigdata/namespace/kb/sparql \
  pnpm --filter @origintrail-official/dkg-storage exec vitest run \
  --config vitest.blazegraph-prefix.config.ts
```

Each run creates and finally removes its own namespace. The benchmark refuses
non-loopback endpoints. No shared graph inventory or persistent cache is used.
The differential tests always run against a real Oxigraph HTTP oracle; the dedicated live config runs the same checks against real Blazegraph and
fails if `BLAZEGRAPH_TEST_URL` is missing. CI runs it in `tornado-blazegraph`.

## Measured setup and results

Official Blazegraph 2.1.6 standalone jar, SHA256
`930c38b5bce7c0ae99701c1f6ef3057c52f3f385d938e1397a3e05561c7df5de`,
Java 20, 128 MiB initial / 512 MiB maximum heap, Node 22.23.2, macOS.
Both paths use the same loopback HTTP proxy to the same local server.
The backend was idle except for these serial requests; the host also ran other
builds, so these are local characterization results, not capacity guarantees.

Eight matching graphs, ten quads per graph, increasing unrelated graph counts;
two warmup pairs then seven measured alternating-order pairs per size. All reads
are fresh. The table reports medians, before / candidate. Service spans admission
to completed decoding, including the identical response-clone instrumentation
used to count wire bytes. It is **not** an engine-internal CPU-time measurement.

| Unrelated graphs | Total graphs | Quads | Rows | Bytes | Queue ms | Admitted service ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 108 | 1080 | 108 / 8 | 9992 / 802 | 0.038 / 0.035 | 6.71 / 20.70 |
| 1000 | 1008 | 10080 | 1008 / 8 | 93692 / 802 | 0.035 / 0.034 | 6.45 / 23.45 |
| 5000 | 5008 | 50080 | 5008 / 8 | 469692 / 802 | 0.053 / 0.052 | 26.77 / 52.33 |

Raw repetitions: [BIND candidate](../benchmarks/graph-prefix-bind.json) and
[ordinary triple-pattern candidate](../benchmarks/graph-prefix-triples.json).
Queue wait was negligible here; this experiment does not reproduce or attribute
the six-wallet queue timeouts in #3253.

## Query selection and correctness

`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ...)) }`
returns correct matches, but reached a median 148.58 ms at 5,008 graphs versus
15.52 ms for full enumeration in its paired run.

The retained candidate binds `STR(?g)` after `GRAPH ?g {}` and filters that bound
variable, then uses `FILTER EXISTS` to preserve nonempty-graph semantics. It was
less slow (52.33 ms at 5,008 graphs), but still slower than its paired baseline
(26.77 ms). A direct `STR(?g)` filter after `GRAPH ?g {}` returned unrelated graphs
on Blazegraph 2.1.6 and was rejected. Differential tests detect that error.

Tests cover literal/escaped/empty prefixes, related textual prefixes, assertion
children, percent and Unicode identifiers, internal staging exclusion, and
insert/delete from another adapter between reads. Half-surrogate JavaScript
prefixes cannot be represented as UTF-8 and deliberately use fresh enumeration
plus the historical JavaScript comparison. The candidate uses the adapter's
public query boundary for abort, deadline, byte limit and scheduler priority;
production graph enumeration and its operation metadata are unchanged.

There is no engine evidence of a prefix index or bounded scan. More triples per
graph, remote latency, concurrency and realistic long graph names may change the
tradeoff. A future candidate should rerun these correctness tests and repeated
measurements before enabling the optional capability. This experiment does not
skip fresh authorization, seal or graph-family validation.
