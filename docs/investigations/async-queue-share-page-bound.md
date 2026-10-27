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

Two details of B's key read matter:

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

## What it cost the complete listing, and what that implies

The cursorless call still has to return everything, and it is now a loop of pages. Every page scans again, so its total cost is
about the number of pages times the matching rows. Measured at 10,000 and 50,000 retained jobs against the previous single read
(`SELECT ?payload` for every job, parsed and sorted, in one hold):

| Complete listing | 10,000 retained | 50,000 retained |
| --- | --- | --- |
| previous single read | 0.18 to 0.21 s, one hold | 1.2 to 1.5 s, one hold |
| 1,000 per page (the default) | 0.8 s, 11 holds of 72 ms (max 84) | 10.0 s, 51 holds of 206 ms (max 285) |
| 500 per page | 1.1 s, 21 holds | 28 s, 101 holds |
| 100 per page | 5.8 s, 101 holds | 125 s, 501 holds |

The loop therefore trades a much shorter mutex hold (0.3 s against 1.3 s at 50,000) for several times more wall time and engine work.
That is the plan's intent (the cursorless default stays complete, "not a snapshot", warned about above a row threshold) and why the page
size of the loop is the maximum, 1,000: the cost falls steeply as the page grows (125 s, 28 s and 10 s per 100, 500 and 1,000 rows at 50,000 retained jobs). Two ways to cut it further, estimated from the parts
measured above and left out of this change because they change the shape of the loop, not its contract:

- Reading the keys once without `ORDER BY` or `LIMIT` (about 0.15 s at 50,000), then the payloads in batches of 1,000 by subject, one
  hold per batch, would make the complete call linear: about 2.8 s at 50,000 retained jobs instead of 10 s.
- Key pages of 10,000 followed by payload batches would give about 3.5 s.

Clients that need the whole history should page with a cursor (the walk does the same total work but spread over the client's own
pace) or filter by state. A filtered complete listing is as cheap as a page: `list({ state: ['queued', 'running', 'failed_retrying'] })` is
31 ms at 0 and 10,000 retained jobs, and a page of the live states is 34 ms at 50,000.

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
- The cost of the cursorless observer's whole call is not flat: 0.8 s per poll at 10,000 and 10 s at 50,000 retained jobs, in many short
  holds. The benchmark's `default` observer measures exactly that call (`queue.list({})`); its `paged` observer now walks `queue.listPage`
  100 rows at a time.

## Reproduce

```bash
docker run -d --name <name> -p 127.0.0.1:<port>:8080 "$(node -p "require('./blazegraph-image.json').image")"
# the engine tables: a namespace per size seeded with scripts/repro/async-queue-seed-history.mjs --load, then the queries above
# the product code, one fresh namespace per size:
DKG_PROMOTE_LISTING_LIVE_HISTORY=50000 BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql \
  pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.blazegraph.config.ts \
  test-live/async-promote-listing.blazegraph.test.ts -t "page cost"
```
