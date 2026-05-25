# ADR 0002 — Importer chunking contract

- **Status**: Accepted
- **Date**: 2026-05-25
- **Authors**: branarakic
- **Related issues**: [#596](https://github.com/OriginTrail/dkg/issues/596), [#602](https://github.com/OriginTrail/dkg/pull/602)
- **Related ADRs**: [0003 — Code-graph ontology convergence](./0003-code-graph-ontology-convergence.md)

## Context

PR [#602](https://github.com/OriginTrail/dkg/pull/602) introduced the "Graphify"
codebase-import experiment, which converts every source file in a repository to
RDF (per-file `code:File` triples, per-package `code:Package` triples,
per-function `code:Function` triples, dependency edges, etc.) and tries to
write the resulting graph into a DKG daemon's working memory in one shot.

For a non-trivial repository the resulting graph is **1.7M quads spread over
~74 assertions** (~150 MB of N-Quads). The push exposed several gaps in how
the daemon's HTTP API expects callers to behave:

1. **No per-request size guard before the daemon got swamped.** The daemon's
   global limits (`MAX_BODY_BYTES = 10 MB`, `SMALL_BODY_BYTES = 256 KB`,
   `MAX_UPLOAD_BYTES = 50 MB` — see
   `packages/cli/src/daemon/http-utils.ts`) exist, but importers had no idea
   what they were until they hit a 413. There was no machine-readable advert
   of those limits in `/api/status`.

2. **No agreed-upon chunk granularity.** Several existing importers in the
   tree pick their own batch sizes — `dkg/.dkg/scripts/scan-code.mjs` uses
   `CHUNK=5000` quads and `ROOT_CHUNK=1000` URIs per promote, but PR #602's
   importer batched larger and slower; PR #602 originally tried a single
   monolithic write, which is impossible by design.

3. **No documented "what to do when 413 happens" pattern.** Importer authors
   reach for retry-with-smaller-chunks the first time, but there's no
   canonical shape.

4. **Recurring confusion about whether the daemon should chunk for the
   caller.** The natural temptation, after seeing a torn 1.7M-quad write,
   is to add `/api/import/bulk` or to bump `MAX_BODY_BYTES` to 1 GB. Both
   are wrong: the assertion-create/write/promote loop is _already_ the
   chunked API. Hiding chunking behind the daemon also defeats the
   resumability the importer needs anyway (a manifest of which slices
   have landed; see §Manifest).

## Decision

**Clients chunk; the daemon publishes the limits clients chunk against.**

Concretely:

1. **The current per-call API contract IS the chunked contract.** Importers
   write a large graph by calling, for each logical slice of triples:

   ```
   POST /api/assertion/create   { name, subGraphName, contextGraphId }
   POST /api/assertion/:name/write    { contextGraphId, subGraphName, quads: [...] }     ── one or more times
   POST /api/assertion/:name/promote  { contextGraphId, subGraphName, entities: [...] }
   ```

   `contextGraphId` (and the matching `subGraphName`) MUST be sent on every
   write and promote, not only on create. The daemon validates them on each
   call — importers that omit the field get HTTP 400 from the request
   validator before any quads are processed. (The earlier draft of this
   ADR showed only `quads`/`entities` in the body; that was wrong.)

   Each `write` body MUST stay under `MAX_BODY_BYTES`. Each `promote`
   `entities` array MUST stay under a comparable URI-count budget. Multiple
   assertions can be created in parallel as long as the writes for a given
   assertion stay sequential within that assertion's lifetime.

2. **Pinned per-call budgets (the actual numbers).** Until per-network/
   per-version values appear in `/api/status` (see §Consequences),
   importers should use these constants verbatim. They are deliberately
   conservative — well under the daemon's hard limits — so a single write
   leaves margin for retries, header overhead, and JSON encoding bloat.

   | Constant       | Value           | Rationale |
   |---|---|---|
   | `CHUNK`        | **5,000 quads** per `/api/assertion/:name/write` call | The 99th-percentile N-Quads quad serialises around 150-300 bytes (URIs + a small literal); 5,000 quads × ~250 B ≈ 1.25 MB, well under the 10 MB `MAX_BODY_BYTES`. Matches the value already in use by `.dkg/scripts/scan-code.mjs`. |
   | `ROOT_CHUNK`   | **1,000 URIs** per `/api/assertion/:name/promote` call | Promote payloads are URI-array-only, so the body is bounded by URI count, not quad count. 1,000 URIs × ~120 B ≈ 120 KB, well under `SMALL_BODY_BYTES`. Also matches the scanner's existing pin. |
   | Max concurrent writes per assertion | **1** | Sequential within an assertion — the daemon's WAL semantics don't support intra-assertion parallel writes today, and the `manifest` (§Manifest) tracks per-assertion state anyway. |
   | Max concurrent assertions | **4** | Concurrency across assertions is safe; this keeps daemon CPU and memory bounded for laptop-class hosts. |

3. **The daemon enforces the limits with HTTP 413 (`PayloadTooLargeError`,
   already imported in every route group in `packages/cli/src/daemon/routes/`).**
   Importers that exceed the budget MUST handle 413 the same way they handle
   transient network errors: catch, halve the chunk size for the next
   attempt, retry. Exponential backoff is fine; this rare path is not a
   hot loop.

4. **The daemon SHOULD publish its current per-call limits in `/api/status`.**
   The status route (`packages/cli/src/daemon/routes/status.ts`) is the
   canonical "ask the node what it can do" surface. A new top-level object
   `importLimits: { maxQuadsPerWrite, maxBodyBytes, maxEntitiesPerPromote,
   smallBodyBytes }` lets importers self-tune for nodes that have raised or
   lowered the defaults. **This advertisement is non-binding** — the hard
   413 enforcement remains in `http-utils.ts`; `/api/status` is a hint, not
   a contract.

5. **The daemon MUST NOT add a server-side "chunk this for me" endpoint
   (`/api/assertion/bulk-write`, `/api/import/auto-chunk`, etc.).** Two
   reasons:

   - It would hide failure modes from the caller. Today a 413 surfaces
     mid-write; the importer sees exactly which slice failed and which
     have landed. A "send me the whole graph" endpoint would either buffer
     in memory (defeating the size limit) or chunk inside the daemon
     (duplicating client-side logic without the manifest the importer
     needs anyway for resumability).

   - It would erase the convergence with industry practice. Every
     RDF-store HTTP API in current use (Apache Jena Fuseki, Stardog,
     GraphDB, Blazegraph) draws the same line: server-side bulk import
     is for _files on disk on the server_, not for HTTP-streaming
     megabytes. Network-fed imports are client-chunked. This is the
     "fetch the headers, then the body, in slices" pattern that every
     megabyte-scale HTTP client follows.

## Manifest

Resumability is part of the chunking contract. An importer that writes 74
assertions cannot afford to start over on slice 75 because the daemon
restarted; it needs to know which slices have landed and which haven't.

The canonical pattern is a small RDF manifest assertion that the importer
maintains as it works. A follow-up implementation PR will ship the
agent-readable importer manual and `scripts/lib/manifest.mjs` helper that
turn this pattern into reusable code; this ADR only defines the contract the
future artifacts must follow.

```
<urn:dkg:import:my-corpus-2026-01-15>
    a                       <https://ontology.dkg.io/import#Import> ;
    dkg:startedAt           "2026-01-15T09:00:00Z"^^xsd:dateTime ;
    dkg:partition           <urn:dkg:import:my-corpus-2026-01-15#part-001>,
                            <urn:dkg:import:my-corpus-2026-01-15#part-002>, ... .

<urn:dkg:import:my-corpus-2026-01-15#part-001>
    dkg:key                 "src/foo/bar.ts" ;
    dkg:status              "done" .
```

The manifest itself follows the chunking contract — typically <100 partitions
fit comfortably in one promote, so the manifest assertion is its own slice.
On resume, the importer reads back the manifest, computes the set of pending
partitions, and continues from there.

## Consequences

**Will change** (in PRs that follow this ADR):

- Future `packages/cli/skills/dkg-importer/SKILL.md` — agent-readable importer manual
  that codifies the contract in §Decision with worked examples (TypeScript
  + Python) and an explicit "what to do on 413" recipe.
- Future `scripts/lib/manifest.mjs` — small library that implements the manifest
  pattern above against the daemon's own assertion API.
- `packages/cli/src/daemon/routes/status.ts` — `/api/status` gains a
  non-binding `importLimits` block reflecting `MAX_BODY_BYTES`,
  `SMALL_BODY_BYTES`, and the pinned `CHUNK`/`ROOT_CHUNK` advisory values.
  This is small and additive; it can land in any future PR without
  disrupting existing clients.
- `packages/cli/skills/dkg-node/SKILL.md` — adds a one-line cross-reference
  to `dkg-importer/SKILL.md` from the "writing graphs" section, plus a
  short HTTP-413 troubleshooting entry.
- `dkg/.dkg/scripts/scan-code.mjs` (companion repo) — annotated to point
  at this ADR so the existing pin matches the documented contract.

**Will not change** (deliberately out of scope):

- `MAX_BODY_BYTES`, `SMALL_BODY_BYTES`, `MAX_UPLOAD_BYTES` constants in
  `packages/cli/src/daemon/http-utils.ts`. Tuning those is a separate
  decision; this ADR is about the contract shape, not the numbers.
- A server-side "bulk import" or "auto-chunk" endpoint. Forbidden per §5
  above. If a future use case argues this is necessary, a separate ADR
  must supersede this one.

## Rejected alternatives

- **"Just raise `MAX_BODY_BYTES` to 1 GB."** Doesn't solve resumability,
  doesn't solve daemon-side memory pressure during the dump (Oxigraph
  loads the request body into memory before parsing), and pushes the
  failure mode from "413 on a 5 MB chunk" to "OOM on a 1 GB chunk".
- **"Server-side chunking endpoint."** Forbidden per §5. Would require
  duplicating manifest logic on both sides.
- **"Per-network chunk values in `/api/status` are binding."** Tried in
  draft. Rejected because some operators want to be able to bump the limit
  for their own importers without forcing every client to re-read status.
  Hard enforcement stays in HTTP code; `/api/status` is a hint.

## Empirical motivation

Quoted from an rc.10 import of this repository's Graphify output
(26,960 nodes / 63,003 edges across 17 partitions), running on a
sandbox daemon (port 9201, single worker, local SSD):

- A hand-rolled importer written from `dkg-node/SKILL.md` alone needed
  **~330 LOC** to land the graph: arg parsing, token resolution, wallet-
  scoped CG id construction, partitioning, write batching, 413-driven
  adaptive halving on `/promote`, 500-driven `entities: "all"` →
  per-root batching on the 10 MB gossip cap, and a hand-rolled JSON
  resume state file. Roughly half of that is cap-discovery ceremony.
- The same workload using rc.10's existing `scripts/lib/dkg-daemon.mjs`
  `DkgClient` cuts the importer to ~half the LOC because token, project
  ensure, sub-graph ensure, and write batching are already handled.
  Importer authors still hand-roll adaptive halving and the resume
  manifest — those are the gaps PRs #642 and #643 close.
- **Four of 17 partitions hit the 10 MB gossip cap** with
  `entities: "all"` (24,599 KB, 11,993 KB, 10,788 KB, 20,686 KB). Each
  failure required halve-and-retry. Total wall-clock spent in retry
  cycles: **~15 minutes** on top of the legitimate write/promote work.
  A documented contract (this ADR) plus a pinned `ROOT_CHUNK ≤ 1000`
  default in the importer SKILL would have avoided all of it.
- Write latency degrades roughly **200× from baseline** once cumulative
  SWM grows past ~100k triples (5-7 ms/batch → 1.2 s/batch and worse),
  because sync `/promote` shares a worker with write ingestion. That
  cost is what motivates PR #643's async queue, not this ADR — but the
  chunking discipline here is the prerequisite: without an agreed-upon
  contract you can't move promote work to a background worker without
  changing the importer's request shape.

The full per-partition breakdown lives in the rc.10 test artifacts;
this section keeps the headlines so the contract's "why these numbers"
question has a concrete answer for reviewers.

## References

- HTTP 413 semantics — [RFC 9110 §15.5.14](https://www.rfc-editor.org/rfc/rfc9110#name-413-content-too-large)
- Apache Jena Fuseki bulk-load — server-local files only, not HTTP-streamed
- Stardog HTTP API — same pattern: server-side bulk for local files,
  client-chunked for remote ingestion
