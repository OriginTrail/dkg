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

<table><thead><tr><th width="273">Area</th><th>Route family</th></tr></thead><tbody><tr><td>Context graphs</td><td><code>/api/context-graph/*</code></td></tr><tr><td>Knowledge Assets and VM publish</td><td><code>/api/knowledge-assets/*</code></td></tr><tr><td>SWM substrate operations</td><td><code>/api/shared-memory/catchup</code>, <code>/api/shared-memory/host-mode/*</code>, <code>/api/shared-memory/verify-batch</code></td></tr><tr><td>Query</td><td><code>/api/query</code></td></tr><tr><td>Agents and messaging</td><td><code>/api/agents</code>, <code>/api/chat</code>, <code>/api/messages</code>, <code>/api/invoke-skill</code></td></tr><tr><td>Node identity and Core profile registration</td><td><code>/api/identity</code>, <code>/api/identity/ensure</code></td></tr><tr><td>Publishing Conviction Accounts</td><td><code>/api/pca/*</code></td></tr><tr><td>Messaging SLOs</td><td><code>/api/slo</code></td></tr><tr><td>Node status and peers</td><td><code>/api/status</code>, <code>/api/peer-info</code>, <code>/api/wallets/balances</code></td></tr></tbody></table>

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
| Enqueue async WM to SWM share | `POST /api/knowledge-assets/{name}/swm/share-async` |
| Inspect async share jobs | `GET /api/knowledge-assets/swm/share-jobs` (the complete list, or one page: [Listing async jobs](#listing-async-jobs)), `GET /api/knowledge-assets/swm/share-jobs/{jobId}` |
| Cancel/recover async share jobs | `DELETE /api/knowledge-assets/swm/share-jobs/{jobId}`, `POST /api/knowledge-assets/swm/share-jobs/{jobId}/recover` |
| Publish SWM to VM | `POST /api/knowledge-assets/{name}/vm/publish` |
| Enqueue async VM publish | `POST /api/knowledge-assets/{name}/vm/publish-async` |
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
- A page can hold fewer jobs than `pageSize` while `nextCursor` is set (a job that no longer matched when its page was read is left out, and a row that cannot be decoded is skipped), and an empty page can carry a `nextCursor`. Stop on `complete`, not on a short page.
- A page is ordered by the time the job was admitted (`enqueuedAt` for share jobs, `acceptedAt` for publish jobs), then by job ID by code point. The complete share list keeps its order by ready time (`nextRetryAt` when a retry is scheduled), and the complete publish list orders jobs admitted in the same millisecond by `localeCompare` of the job ID. The orders differ only for those ties and for retry times.

Request errors are `400` with a stable `code` and a message that never repeats the input:

| Code | When |
|---|---|
| `PROMOTE_LIST_CURSOR_INVALID` / `PUBLISHER_LIST_CURSOR_INVALID` | `cursor` is empty, repeated, not one a page of that list returned (a cursor of the other list included) or was edited. |
| `PROMOTE_LIST_PAGE_SIZE_INVALID` / `PUBLISHER_LIST_PAGE_SIZE_INVALID` | `pageSize` is repeated or not an integer from 1 to 1,000. |
| `LIST_PAGING_LIMIT_CONFLICT` | `limit` was sent with `cursor` or `pageSize`. |
| `PUBLISHER_LIST_STATUS_INVALID` | The publisher route's `status` is not one of `accepted`, `claimed`, `validated`, `broadcast`, `included`, `finalized`, `failed` (in both modes; an empty `status` is no filter). It used to answer an empty list. |

Store pressure keeps its usual answer: `503` with `code: "STORE_SCHEDULER_BUSY"` (or `STORE_OPERATION_TIMEOUT`), `retryable: true` and `Retry-After: 1`; retry the same request, the cursor stays valid. A stored job that cannot be placed in the page order is a `500`; the complete list still answers.

The CLI wraps both lists: [`dkg ka share-jobs` and `dkg publisher jobs`](cli.md) take `--page-size`, `--cursor` and `--all`.
