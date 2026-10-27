# Share job page cost on Blazegraph (OT-RFC-73 P8a discovery)

OT-RFC-73 plan section 5.3 asks for a measurement before the share listing is paged: "the engine scan is O(filtered rows), so time the
page query on Blazegraph at 0, 10k and 50k, and declare its bound as part of AC5." This note is that measurement, the shape it chose
and the bound it declares. The listing behavior it led to is in [async-share-admission.md](../api/async-share-admission.md#listing-paging-statistics-and-the-post-commit-sweep).

## Setup

- Engine: `islandora/blazegraph:6.4.3` as pinned in `blazegraph-image.json` (digest `sha256:015e308a...`), a disposable container on
  loopback, default JVM settings, Apple M2 Pro, 10 CPUs, Docker 8 GB. Nothing else was running against it.
- Data: `scripts/repro/async-queue-seed-history.mjs --jobs 10k|50k --base-time 1790000000000 --load <namespace>` into one fresh
  namespace per size (0, 10,000 and 50,000 terminal `succeeded` share jobs: 8 quads and about 2.2 KB each, all distinct selectors, one
  context graph, timestamps one second apart), plus the same 43 live jobs in each: 20 `queued`, 3 `running`, 5 `failed_retrying`, 10
  `failed` (6 of them post-commit failures) and 5 `queued` in a second context graph. "0 retained" therefore means the 43 live jobs only.
- Method: raw SPARQL `POST` to the namespace, wall time of request plus response parse, 3 discarded warm-ups then 12 to 15 timed runs,
  variants interleaved in random order where they were compared, median (p50) and 95th percentile. Then the same pages through the product code
  (`test-live/async-promote-listing.blazegraph.test.ts`, below), which adds the store adapter, the payload decode and the mutex.

## Query shapes compared

All return the page's rows in `(enqueuedAt, jobId)` order with `LIMIT n + 1`. This first comparison ordered on a computed
`STR(?job)`; the cheaper ordering found afterwards is below.

| Shape | What it does |
| --- | --- |
| A | one query: a sub-select for the keys, joined to the payload triple |
| B | two queries: the keys, then the payloads of the page's subjects by `VALUES ?job { ... }` |
| C | one query with the payload triple in the same pattern as the ordering |

At 50,000 retained jobs, first page of 100, median ms:

| Filter | A | B | C |
| --- | --- | --- | --- |
| none (matches 50,043 jobs) | 374 | 335 | 389 |
| `succeeded` (matches 50,000) | 364 | 318 | 390 |
| live states (matches 33) | 56 | 33 | 17 |
| `failed` + one context graph (matches 10) | 57 | 30 | 17 |

C is cheapest for a selective filter but fetches the payload of every matching row before the sort, which is exactly the full payload
read the plan rules out; with a broad filter it is the slowest. A grows with the history even for a selective filter (30, 38, 56 ms at
0, 10k and 50k) because the engine joins the payload before it cuts. **B is used**: flat for a selective filter, no worse than A for a
broad one, and its payload read is bounded by the page.

Two details of B's key read matter (and a third, added after review: the key read is `SELECT DISTINCT ?job ?enq`, so a record with a
second state triple is one row and not one per triple; re-measured, the first page and the page after it at 50,000 retained jobs are
148 ms and 274 ms, within noise of the 156 and 335 ms below):

- `ORDER BY ?enq ?job` is 2.3 times cheaper than ordering on a computed `STR(?job)` (120 ms against 283 ms at 50,000, keys only), because
  the engine does not materialize 50,000 IRI strings. A check on 600 random mixed-case job IDs loaded in six separate batches shows
  that Blazegraph's `ORDER BY ?job` and its string comparison in `FILTER` are the code point order the cursor is defined by, ties on the
  timestamp included. The page read still checks the order of what it gets and fails instead of skipping or repeating a job if a store
  ever orders otherwise.
- The cursor filter is `FILTER (?enq >= t) FILTER (?enq > t || STR(?job) > "...")`: the first is a plain range, the second keeps the rows after
  the cursor, comparing the job IRI only for rows that share the cursor's timestamp. It is the cheapest correct form measured for a cursor deep in the
  history (129 ms against 197 ms for the single `OR` form at 50,000). It costs up to twice a first page when most rows follow the cursor
  (248 ms against 119 ms engine only, 335 ms against 156 ms through the product code).

## Page cost

Engine only (raw query, keys plus payloads of the page), median / p95 ms:

| Page | 0 retained | 10,000 | 50,000 |
| --- | --- | --- | --- |
| no filter, first page of 100 | 30 / 34 | 42 / 47 | 161 / 193 |
| no filter, first page of 500 | 30 / 35 | 39 / 46 | 158 / 187 |
| no filter, first page of 1,000 | 30 / 37 | 49 / 58 | 170 / 196 |
| no filter, cursor half way (100) | - | 53 / 57 | 213 / 229 |
| no filter, cursor 90% in (100) | - | 40 / 55 | 129 / 170 |
| `succeeded`, first page of 100 | - | 43 / 46 | 161 / 199 |
| live states, 33 rows | 33 / 35 | 29 / 32 | 31 / 34 |
| `failed` + one context graph, 10 rows | 31 / 34 | 30 / 41 | 29 / 34 |

Through the product code on a fresh namespace per size (`DKG_PROMOTE_LISTING_LIVE_HISTORY=<size> ... -t "page cost"`; the history plus
20 `queued` and 6 `failed` jobs), parse and the mutex included, median of 7 ms (first page / the page after it):

| Page | 0 retained | 10,000 | 50,000 |
| --- | --- | --- | --- |
| no filter, 100 per page | 30 | 45 / 73 | 156 / 335 |
| no filter, 1,000 per page | 33 | 56 / 109 | 161 / 289 |
| `succeeded`, 100 per page | 24 | 59 / 92 | 133 / 258 |
| live states, 100 per page | 31 | 32 | 34 |
| `getStats()` | 15 | 16 | 40 |
| sweep over 6 failed jobs (steady state) | 16 | 19 | 18 |

**The bound.** A page costs the rows that match its filter, not its size: it is O(filtered rows), as the plan expected. For a filter
that matches the whole retained history a page of up to 1,000 jobs takes at most about 0.04 s at 0, 0.11 s at 10,000 and 0.35 s at
50,000 retained jobs (the pages after the first cost up to twice a first page); for a filter that matches few rows it stays at about
0.03 s whatever the history. The share mutex is therefore held for at most that long per page, where the single complete read held it for
the whole read (1.2 to 1.5 s at 50,000 retained jobs, and longer under load).

## What the complete listing costs, and how it was made linear

The cursorless call has to return everything. The first version of this change made it a loop of keyset pages of 1,000 rows. Every pass
reran the filtered, ordered scan, so its total cost grew with the pages times the matching rows (quadratic in the history), and `limit`,
which is applied after the ready-time sort, still paid the whole loop.

The shipped design reads the ordered keys in **key pages of 10,000** (`listKeyPageSize`: one scan each, so 6 at 50,026 rows
instead of 51), then fetches the payloads of those keys **by subject in batches of 1,000** (`listPageSize`), and takes the mutex once per
key read and once per batch. No hold fetches a full payload set. A payload batch cannot see a job that changed since its key was read, so
each decoded row is checked against the filter again in the hold that read it. With a `limit` the walk stops as soon as no unread job
can rank among the first `limit` rows (the keys arrive in enqueue order and the result is in ready order; see the module comment of
`promote-job-listing.ts`), so `?limit=10` pays one small batch.

Complete listing through the product code on the pinned image, fresh namespace per size, median of 3 timed runs after a warm-up (Apple M2
Pro, Docker 8 GB). "Longest wait" is the longest latency of a job-status read that arrives while the listing runs: it takes the same mutex
as an admission, a claim and a heartbeat, so it is how long the listing keeps them waiting (an idle status read takes 15 ms).

| Complete `list()` | 0 retained | 10,000 | 50,000 |
| --- | --- | --- | --- |
| previous single read (before P8a; measured earlier) | - | 0.18 to 0.21 s, one hold | 1.2 to 1.5 s, one hold |
| page loop, 1,000 rows per page (first version of this change) | 53 ms, 2 queries, longest wait 54 ms | 1,034 ms, 22 queries, longest wait 185 ms | 10,073 ms, 102 queries, longest wait 329 ms |
| keys in pages of 10,000, payloads in batches of 1,000 (shipped) | 64 ms, 2 queries, longest wait 33 ms | 520 ms, 13 queries, longest wait 84 ms | 3,183 ms, 57 queries, longest wait 288 ms |
| `limit: 10`, page loop | 53 ms | 993 ms, longest wait 119 ms | 9,812 ms, longest wait 286 ms |
| `limit: 10`, shipped | 87 ms, 3 queries | 117 ms, 3 queries, longest wait 68 ms | 228 ms, 3 queries, longest wait 180 ms |
| live states (`queued`, `running`, `failed_retrying`), shipped | 65 ms | 70 ms | 60 ms |

At 50,000 retained jobs the complete call falls from 10.1 s to 3.2 s (3.2 times), and from 1.0 s to 0.5 s at 10,000; the work is now
6 ordered scans (five full key pages and one of the last 26 rows) plus 51 payload batches instead of 51 scans plus 51 batches. A call with a `limit` falls from 9.8 s to 0.23 s (43 times).
The longest hold is one key read of up to 10,000 rows at a deep cursor (268 ms, the slowest single query, at 50,000 retained jobs) or
one batch (tens of milliseconds), against 1.2 to 1.5 s for the single read before P8a; the longest wait is flat to the page bound
declared below, and no longer grows with the number of pages.

Reading the keys in one scan is cheaper in total but holds longer and holds more in memory. Measured the same way at 50,000 retained
jobs with `listKeyPageSize: 100000` (one key read of 50,026 rows): the complete call takes 2.4 s (against 3.2 s), but the longest wait
is 390 ms (against 288 ms) and `limit: 10` takes 462 ms (against 228 ms), because that call must fetch every key before it can cut.
Pages of 10,000 were kept: they bound the memory of a key read (about 1.5 MB), keep a `limit` call cheap, and cost 0.8 s of total time
at 50,000. The size is a queue setting (`listKeyPageSize`, at most 100,000).

Clients that need the whole history can still page with a cursor (the same total scans, at the client's pace) or filter by state: a
filtered complete listing is as cheap as a page (`list({ state: ['queued', 'running', 'failed_retrying'] })` takes 60 to 70 ms at every
size above).

## Other queries measured

Engine only, median / p95 ms:

| Query | 0 retained | 10,000 | 50,000 |
| --- | --- | --- | --- |
| `COUNT(?job) GROUP BY ?state` over the state triples (used) | 15 / 20 | 15 / 18 | 42 / 62 |
| the same also requiring the payload triple | 15 / 19 | 31 / 42 | 99 / 117 |
| post-commit sweep page: `failed` plus `CONTAINS(STR(?payload), ...)`, 100 | 18 / 22 | 16 / 21 | 17 / 19 |
| previous complete read (`SELECT ?payload`, every job, 50,043 rows, about 100 MB) | 15 / 16 | 94 / 101 | 542 / 584 |

The statistics do not need the payload triple. The sweep's text filter runs only over the `failed` jobs, so it does not grow with the
history of other states.

## AC5 reading

- The P8a bound for AC5 is the product-code table above: at 50,000 retained jobs a listing page is held for at most about 0.35 s (0.16 s for
  a first page), against 1.2 to 1.5 s for the single read, so a share submission that arrives during an observer's page waits at most that
  page, and at most one page per observer poll.
- The cost of the cursorless observer's whole call is not flat, but it is linear in the history and split into short holds: 0.5 s per poll
  at 10,000 and 3.2 s at 50,000 retained jobs (10 s in the first version of this change), with a longest wait of 84 ms and 288 ms. The
  benchmark's `default` observer measures exactly that call (`queue.list({})`); its `paged` observer now walks `queue.listPage` 100 rows
  at a time.

## Reproduce

```bash
docker run -d --name <name> -p 127.0.0.1:<port>:8080 "$(node -p "require('./blazegraph-image.json').image")"
# the engine tables: a namespace per size seeded with scripts/repro/async-queue-seed-history.mjs --load, then the queries above
# the product code, one fresh namespace per size:
DKG_PROMOTE_LISTING_LIVE_HISTORY=50000 BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql \
  pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.blazegraph.config.ts \
  test-live/async-promote-listing.blazegraph.test.ts -t "page cost"
# the complete listing (total time and the longest wait of a status read that arrives meanwhile), one namespace per size:
DKG_PROMOTE_LISTING_LIVE_HISTORY=50000 BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql \
  pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.blazegraph.config.ts \
  test-live/async-promote-listing.blazegraph.test.ts -t "complete listing cost"
# add DKG_PROMOTE_LISTING_LIVE_KEY_PAGE=<keys> to change the key page of that listing
```
