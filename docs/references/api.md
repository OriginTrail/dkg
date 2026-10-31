---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# API

The node API lets an application retrieve graph evidence, contribute knowledge, and participate in sharing and publication under its own credentials. Start with a concrete workflow, then use the route reference to extend it.

Use [Feature availability](availability.md) for supported baselines and the generated [Tool and route map](tool-route-map.md) for discovery.

Start with [Integrate an application over HTTP](../build/http-application.md) for a runnable client, request bodies, result checks, and error handling.

The detailed operational contract is maintained in the DKG Node Skill template and served with live node information:

* `packages/cli/skills/dkg-node/SKILL.md`
* `GET /.well-known/skill.md` on a running daemon

Use the installed node's skill and version when integrating. Live state is substituted into a maintained template; this is not a generated OpenAPI schema. The main route families are:

<table><thead><tr><th width="273">Area</th><th>Route family</th></tr></thead><tbody><tr><td>Context graphs</td><td><code>/api/context-graph/*</code></td></tr><tr><td>Knowledge Assets and VM publish</td><td><code>/api/knowledge-assets/*</code></td></tr><tr><td>SWM substrate operations</td><td><code>/api/shared-memory/catchup</code>, <code>/api/shared-memory/host-mode/*</code>, <code>/api/shared-memory/verify-batch</code></td></tr><tr><td>Query</td><td><code>/api/query</code></td></tr><tr><td>Agents and messaging</td><td><code>/api/agents</code>, <code>/api/chat</code>, <code>/api/messages</code>, <code>/api/invoke-skill</code></td></tr><tr><td>Node identity and Core profile registration</td><td><code>/api/identity</code>, <code>/api/identity/ensure</code></td></tr><tr><td>Publishing Conviction Accounts</td><td><code>/api/pca/*</code></td></tr><tr><td>Messaging SLOs</td><td><code>/api/slo</code></td></tr><tr><td>Node status and peers</td><td><code>/api/status</code>, <code>/api/peer-info</code>, <code>/api/wallets/balances</code></td></tr><tr><td>Async publish job queue</td><td><code>/api/publisher/*</code> (jobs, job, job-payload, job-by-intent, journal, stats, cancel, retry, clear, clear-job; node-admin pause, resume and control)</td></tr><tr><td>Scheduler diagnostics (node-admin)</td><td><code>/api/diagnostics/backpressure</code></td></tr><tr><td>CPU profile of the node (node-admin)</td><td><code>/api/diagnostics/cpu-profile</code> (<a href="../use-dkg/troubleshooting.md#slow-or-stalled-node-record-a-cpu-profile">how to use it</a>)</td></tr></tbody></table>

## Context Graph Listing

`GET /api/context-graph/list` without any of the options below retains the legacy
`{ "contextGraphs": [...] }` response for existing clients, and a parameter the
route does not know is ignored. New clients should use the bounded form:

```text
GET /api/context-graph/list?limit=100&projection=summary
```

The bounded form orders rows deterministically and returns `nextCursor` while
more rows remain. Pass that opaque cursor with the same filters and projection
to read the next page. The cursor is bound to the first page's collection; if
the registry changes during the walk, the server returns `409` with
`CONTEXT_GRAPH_LIST_SNAPSHOT_CHANGED` and the client must restart at page one.
`limit` defaults to 50 and cannot exceed 100. Every
bounded response is capped at 64 KiB of serialized JSON; the server may return
fewer rows than requested to stay below that byte limit.

Supported filters are `subscribed=true|false`, `synced=true|false`,
`onChain=true|false`, and `q=<id-or-name-substring>`. `projection=summary`
returns the fields used by list views and caps names at 256 characters and
descriptions at 512 characters, with `nameTruncated` or
`descriptionTruncated` when applicable. `projection=full` retains complete row
fields within the same response bound.

Paged responses include `page.returned`, `page.total`, `page.serializedBytes`,
and `page.maxSerializedBytes`. Counts and exact response bytes are also exposed
as `X-DKG-Result-Count`, `X-DKG-Total-Count`, and `X-DKG-Response-Bytes` headers;
route timing is exposed through `X-DKG-Route-Ms` and `Server-Timing`. Send the
first page's `ETag` in `If-None-Match`; a
`304 Not Modified` means the complete filtered collection is unchanged, not
only the first page.

## Knowledge Asset Lifecycle

Named Knowledge Assets use the lifecycle route family below. The active publishing path is create, write, finalize, share, then publish; VM publishing always operates on a named KA that has already been shared to SWM.

| Lifecycle step | Route |
|---|---|
| Create/open WM draft | `POST /api/knowledge-assets` |
| Write RDF quads | `POST /api/knowledge-assets/{name}/wm/write` |
| Import a document | `POST /api/knowledge-assets/{name}/wm/import-file` |
| Check import status | `GET /api/knowledge-assets/{name}/wm/extraction-status` |
| Finalize/seal | `POST /api/knowledge-assets/{name}/wm/finalize` |
| Share WM to SWM | `POST /api/knowledge-assets/{name}/swm/share` |
| Enqueue async WM to SWM share | `POST /api/knowledge-assets/{name}/swm/share-async` (responses: [Async Share and Publish Jobs](../build/async-jobs.md)) |
| Inspect async share jobs | `GET /api/knowledge-assets/swm/share-jobs` (the complete list, or one page: [Listing async jobs](#listing-async-jobs)), `GET /api/knowledge-assets/swm/share-jobs/{jobId}` |
| Cancel/recover/clear async share jobs | `DELETE /api/knowledge-assets/swm/share-jobs/{jobId}` (`queued` jobs only), `POST /api/knowledge-assets/swm/share-jobs/{jobId}/recover`, `POST /api/knowledge-assets/swm/share-jobs/{jobId}/clear` (removes one finished job; `409` while the job is not finished or still has recovery work to do; API only for now) |
| Reconcile an async share whose replies were lost | `GET /api/knowledge-assets/swm/share-jobs/reconcile` (read-only; see [Async Share and Publish Jobs](../build/async-jobs.md)) |
| Publish SWM to VM | `POST /api/knowledge-assets/{name}/vm/publish` |
| Enqueue async VM publish | `POST /api/knowledge-assets/{name}/vm/publish-async` |
| Inspect async publish jobs | `GET /api/publisher/jobs` (the complete list, or one page: [Listing async jobs](#listing-async-jobs)), `GET /api/publisher/job?id={jobId}`, `GET /api/publisher/stats` |
| Cancel/retry/clear async publish jobs | `POST /api/publisher/cancel` (`accepted` jobs only), `POST /api/publisher/retry`, `POST /api/publisher/clear` (bulk), `POST /api/publisher/clear-job` (one job); see [Async Publisher Wallets](../use-dkg/async-publisher-wallets.md) |
| Seed/edit from SWM or VM | `POST /api/knowledge-assets/{name}/wm/pull-from` |
| Discard WM draft | `POST /api/knowledge-assets/{name}/wm/discard` |
| Read WM quads | `GET /api/knowledge-assets/{name}/wm/quads` |
| Read lifecycle descriptor | `GET /api/knowledge-assets/{name}` |

Both VM publish routes accept `options.publisherNodeIdentityIdOverride`. Use a non-negative decimal string; `0` means explicit no-attribution. Omit the option to use the publisher wallet's resolved default identity, which may also be `0`. Optional node attribution for a separate publisher wallet can be configured through `/api/operational-wallets`.

For exact request bodies, response shapes, and MCP tool names, use [Node Skill](node-skill.md).

## Listing async jobs

`GET /api/knowledge-assets/swm/share-jobs` (async share jobs) and `GET /api/publisher/jobs` (async publish jobs) answer with **every job that matches the filters** by default, as `{ "jobs": [...] }`. That is unchanged. On a node with a long job history that read takes long, so both routes can also page. Paging is opt-in: a request that sends neither `cursor` nor `pageSize` gets the complete list.

| Parameter | Meaning |
|---|---|
| `pageSize` | Pages the list. An integer from 1 to 1,000 (100 when only `cursor` is sent). `pageSize` alone asks for the first page. |
| `cursor` | Pages the list. The `nextCursor` of the previous page, passed back unchanged; it is opaque, so never build or edit one. A cursor made for the other list is refused. |

The filters keep working in both modes: `state` and `contextGraphId` on the share route, `status` and `contextGraphId` on the publisher route. `limit` caps the complete share list (the publisher route has never honored it) and is refused together with `cursor` or `pageSize`.

A paged response is `{ "jobs": [...], "nextCursor": "...", "complete": false }`. `nextCursor` is `null` and `complete` is `true` on the last page. Follow `nextCursor` until `complete` is true:

```bash
cursor=""
while :; do
  page=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9200/api/publisher/jobs?pageSize=500${cursor:+&cursor=$cursor}")
  echo "$page" | jq -c '.jobs[]'
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done
```

What a walk guarantees, while jobs are being added and changed:

- No job is returned twice, and every job that matched the filters for the whole walk is returned exactly once. A job that changes state between two pages keeps its place.
- A job admitted after the walk passed its position is not part of the walk: one that sorts after the cursor is returned by a later page, one that sorts before it (the same timestamp and a lower job ID, or an earlier timestamp) is not. It is not a snapshot.
- **`complete` means no further row followed the page when it was read. It is never proof that a job does not exist.** A client that is waiting for a job keeps polling, or reads that job by ID; it does not conclude from a finished walk that the job was lost.
- A node can remove finished jobs: an operator clears them, or [finished-job cleanup](../use-dkg/async-queue-operations.md#clean-up-finished-jobs) removes them (off by default). A removed job is missing from every list, and its status read answers `404`. That is not proof that the job never ran either.
- A page can hold fewer jobs than `pageSize` while `nextCursor` is set (a job that no longer matched when its page was read is left out, and a row that cannot be decoded is skipped), and an empty page can carry a `nextCursor`. Stop on `complete`, not on a short page.
- A page is ordered by the time the job was admitted (`enqueuedAt` for share jobs, `acceptedAt` for publish jobs), then by job ID by code point. The complete share list keeps its order by ready time (`nextRetryAt` when a retry is scheduled), and the complete publish list orders jobs admitted in the same millisecond by `localeCompare` of the job ID. The orders differ only for those ties and for retry times.

Paging errors carry a stable `code`. A request error is a `400` with a message that never repeats the input:

| Status | Code | When |
|---|---|---|
| `400` | `PROMOTE_LIST_CURSOR_INVALID` / `PUBLISHER_LIST_CURSOR_INVALID` | `cursor` is empty, repeated, not one a page of that list returned (a cursor of the other list included) or was edited. |
| `400` | `PROMOTE_LIST_PAGE_SIZE_INVALID` / `PUBLISHER_LIST_PAGE_SIZE_INVALID` | `pageSize` is repeated or not an integer from 1 to 1,000. |
| `400` | `LIST_PAGING_LIMIT_CONFLICT` | `limit` was sent with `cursor` or `pageSize`. |
| `400` | `PUBLISHER_LIST_STATUS_INVALID` | The publisher route's `status` is not one of `accepted`, `claimed`, `validated`, `broadcast`, `included`, `finalized`, `failed` (in both modes; an empty `status` is no filter). It used to answer an empty list. |
| `501` | `PROMOTE_LIST_PAGING_UNSUPPORTED` | The share route was asked for a page (`cursor` or `pageSize`) and this node's share queue cannot page. A node built from this repository always can, so this is not expected in production; list without `cursor` and `pageSize` instead, which every queue answers. |

Store pressure keeps its usual answer: `503` with `code: "STORE_SCHEDULER_BUSY"` (or `STORE_OPERATION_TIMEOUT`), `retryable: true` and `Retry-After: 1`. On the share route, `"priority": "control"` in the body means the share queue's own store slot refused the read. Retry the same request; the cursor stays valid.

A job whose stored payload cannot be decoded is skipped. A page that cannot be put in order is a `500` with the fixed message `The job list cannot be paged: a stored job row is unreadable or out of order (see the node log)`. The message names no job, and the node logs one `[list-paging] ... answering 500` warn line, without a job ID, for each such request. On the publisher route the complete list still answers then. The share route's complete list reads the same ordered records, so it fails too.

The CLI wraps both lists: [`dkg ka share-jobs` and `dkg publisher jobs`](cli.md#listing-async-jobs) take `--page-size`, `--cursor` and `--all`. What each job state and response means for a client is in [Async Share and Publish Jobs](../build/async-jobs.md).
