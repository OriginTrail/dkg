---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# API

The canonical route contract is generated from the running daemon and exposed to agents through the DKG Node Skill:

* `packages/cli/skills/dkg-node/SKILL.md`
* `GET /.well-known/skill.md` on a running daemon

Use this page as a lookup pointer, not as a duplicate API definition. The highest-risk route families are:

<table><thead><tr><th width="273">Area</th><th>Route family</th></tr></thead><tbody><tr><td>Context graphs</td><td><code>/api/context-graph/*</code></td></tr><tr><td>Knowledge Assets and VM publish</td><td><code>/api/knowledge-assets/*</code></td></tr><tr><td>SWM substrate operations</td><td><code>/api/shared-memory/catchup</code>, <code>/api/shared-memory/host-mode/*</code>, <code>/api/shared-memory/verify-batch</code></td></tr><tr><td>Query</td><td><code>/api/query</code></td></tr><tr><td>Agents and messaging</td><td><code>/api/agents</code>, <code>/api/chat</code>, <code>/api/messages</code>, <code>/api/invoke-skill</code></td></tr><tr><td>Node identity and Core profile registration</td><td><code>/api/identity</code>, <code>/api/identity/ensure</code></td></tr><tr><td>Publishing Conviction Accounts</td><td><code>/api/pca/*</code></td></tr><tr><td>Messaging SLOs</td><td><code>/api/slo</code></td></tr><tr><td>Node status and peers</td><td><code>/api/status</code>, <code>/api/peer-info</code>, <code>/api/wallets/balances</code></td></tr></tbody></table>

## Context Graph Listing

`GET /api/context-graph/list` without query parameters retains the legacy
`{ "contextGraphs": [...] }` response for existing clients. New clients should
use the bounded form:

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
| Enqueue async WM to SWM share | `POST /api/knowledge-assets/{name}/swm/share-async` |
| Inspect async share jobs | `GET /api/knowledge-assets/swm/share-jobs`, `GET /api/knowledge-assets/swm/share-jobs/{jobId}` |
| Cancel/recover async share jobs | `DELETE /api/knowledge-assets/swm/share-jobs/{jobId}`, `POST /api/knowledge-assets/swm/share-jobs/{jobId}/recover` |
| Publish SWM to VM | `POST /api/knowledge-assets/{name}/vm/publish` |
| Enqueue async VM publish | `POST /api/knowledge-assets/{name}/vm/publish-async` |
| Seed/edit from SWM or VM | `POST /api/knowledge-assets/{name}/wm/pull-from` |
| Discard WM draft | `POST /api/knowledge-assets/{name}/wm/discard` |
| Read WM quads | `GET /api/knowledge-assets/{name}/wm/quads` |
| Read lifecycle descriptor | `GET /api/knowledge-assets/{name}` |

Both VM publish routes accept `options.publisherNodeIdentityIdOverride`. Use a non-negative decimal string; `0` means explicit no-attribution. Omit the option to use the publisher wallet's resolved default identity, which may also be `0`. Optional node attribution for a separate publisher wallet can be configured through `/api/operational-wallets`.

For exact request bodies, response shapes, and MCP tool names, use [Node Skill](node-skill.md).
