---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Integrate an application over HTTP

Use the node's authenticated HTTP API when integrating an existing service. This example uses Node.js 22.13+ and the built-in `fetch`; it does not import monorepo internals. The sample creates and reads a WM draft. Sharing is a separate command and there is no publish command in the example.

## Connection and credentials

Start a node and create a Context Graph as in the [quickstart](../getting-started/quickstart.md). Copy its exact ID. On the node host, a local operator can discover the local token with `dkg auth show`. For a remote application, the operator registers an agent and provisions its returned `authToken` through the application's secret store. Keep the node-admin token on its owner host.

Set these environment variables in the application's environment (do not commit their values):

```bash
export DKG_NODE_URL='http://127.0.0.1:9200'
export DKG_CONTEXT_GRAPH='<exact existing Context Graph ID>'
export DKG_KA_NAME='atlas-app'
# Local operator demonstration only:
export DKG_AUTH_TOKEN="$(dkg auth show)"
```

For remote access, use an operator-configured HTTPS endpoint. Opening a public port is not an authentication strategy. Agent credentials and the application's own end-user authorization are separate: decide which graphs and records each user may access before forwarding requests.

## Run the supplied client

Get [`http-app.mjs`](https://github.com/OriginTrail/dkg/blob/testnet-canary/examples/docs/http-app.mjs) and [`atlas-query.rq`](https://github.com/OriginTrail/dkg/blob/testnet-canary/examples/docs/atlas-query.rq) from the same reviewed repository revision and save them together. From that directory:

```bash
node http-app.mjs write
node http-app.mjs read
```

`write` creates the named draft and appends the five sample triples. `read` queries the requested Context Graph's Working Memory. Expect a bindings result containing Atlas, Oxigraph, and `https://example.org/dkg-tutorial/source`. Rerun `read` in a new process to demonstrate that the data is in the node. The example prints returned evidence, not a model-generated answer.

For an intentional share of this public sample:

```bash
node http-app.mjs share
node http-app.mjs read shared-working-memory
```

The client checks HTTP errors and partial `207` results, uses a bounded request timeout, and never retries a mutation automatically. It is a minimal example, not a background ingestion service.

## The request contract

All JSON writes send `Content-Type: application/json` and a bearer token.

| Operation | Method and route | Body or query | Evidence to inspect |
| --- | --- | --- | --- |
| Caller identity | `GET /api/agent/identity` | None | `agentAddress` and the expected caller |
| Create WM draft | `POST /api/knowledge-assets` | `{ "contextGraphId": "<id>", "name": "atlas-app" }` | Named assertion/KA and status |
| Write | `POST /api/knowledge-assets/atlas-app/wm/write` | `{ "contextGraphId": "<id>", "quads": [...] }` | Written count; inspect contents |
| Read graph | `POST /api/query` | `{ "contextGraphId": "<id>", "view": "working-memory", "sparql": "..." }` | `result.type` and `result.bindings` |
| Seal | `POST /api/knowledge-assets/atlas-app/wm/finalize` | `{ "contextGraphId": "<id>" }` | Seal metadata and author |
| Share | `POST /api/knowledge-assets/atlas-app/swm/share` | `{ "contextGraphId": "<id>", "entities": "all" }` | Completion without nested errors |

A quad is `{ "subject": "<IRI>", "predicate": "<IRI>", "object": "<IRI or RDF literal>" }`. For a string literal the object includes RDF quotes, for example `"object": "\"Atlas\""`. The node controls WM graph placement; do not invent per-quad graph routing. Query views are `working-memory`, `shared-working-memory`, and `verifiable-memory`; specify the exact Context Graph with the view.

The [Node Skill](../references/node-skill.md) is the complete operational reference. Match it to the running version and use discovered MCP schemas when calling tools instead of HTTP.

## Handle incomplete operations

| Result | Application behavior |
| --- | --- |
| `400` | Correct the payload/identifier; repeating it will not fix it |
| `401` / `403` | Resolve credentials or permissions; do not broaden access automatically |
| `404` | Check the exact graph/KA/route and installed version |
| `409` | Inspect the conflict or existing job; do not create a replacement KA to bypass it |
| `207` or nonempty `errors` | Inspect partial effects before proceeding |
| `413` | Reduce the payload using [large-content guidance](../use-dkg/large-content.md) |
| `429` / retryable `503` | Follow the operation's backoff/recovery contract; preserve its identity |
| Network timeout | Outcome may be unknown; inspect the KA or job before repeating a mutation |

For async sharing, store the returned job ID and poll `/api/knowledge-assets/swm/share-jobs/{jobId}`. `queued`, `running`, and `failed_retrying` are not success; completion requires `succeeded`. Inspect terminal failures before recovery. For publication, use the distinct [publisher job contract](../use-dkg/async-publisher-wallets.md); its states and transaction recovery are not the share queue's states.

## Extend the example

Assign stable source/entity identifiers, record provenance, and keep a durable import manifest for resumable ingestion. Treat retries, schema migrations, updates, deletion, and per-user access as application requirements. Validate returned evidence before allowing an agent to act on it.
