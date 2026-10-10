# Bounded local SELECT reads

This additive daemon capability supports consumers that must distinguish no
matches from an unavailable, denied or truncated query. Existing `/api/query`
behavior is unchanged. This API is proposed in source; it is not in the published
10.0.23 package.

`GET /api/query/bounded` reports version 1 and its hard ceilings. `POST` uses the
normal daemon authentication, caller identity, Context Graph authorization,
query scoping and store admission lane. It reads the local store and refuses
SPARQL `SERVICE`; it does not forward a query to peers or initiate recovery.
A consumer handling private action data must additionally constrain its client
to a local connection. The daemon capability is not itself a loopback firewall.

Example body (the Context Graph must be readable by the authenticated caller):

```json
{
  "version": 1,
  "contextGraphId": "example",
  "sparql": "SELECT ?subject WHERE { ?subject a <urn:example:Signal> }",
  "maxRows": 100,
  "timeoutMs": 500,
  "includeContextGraphPartitions": true
}
```

Supported views: default graph scope, `verifiable-memory` and
`shared-working-memory`. Explicit graph references remain subject to normal CG
scoping. `includeContextGraphPartitions` is opt-in and does not widen CG access.
Working-memory and unscoped reads are intentionally outside this contract.

SELECT must have a WHERE clause, no dataset clause, no remote SERVICE and no
top-level LIMIT/OFFSET. Query text is limited to 64 KiB (the enclosing JSON
also remains subject to the existing small-body limit). Nested SELECTs remain
subject to the existing scope guards, including refusal of nested GRAPH
variables that cannot be safely constrained.

The route appends `LIMIT maxRows + 1` as an overflow witness. The maximum is
8,192 returned rows and 1 MiB of serialized result data. An over-limit result
returns 422 `QUERY_RESULT_TOO_LARGE` in the default `mode: "complete"`,
never a successful truncated decision. HTTP
store responses receive the same byte ceiling before JSON parsing through
`maxResponseBytes`; embedded stores are checked after their synchronous result
returns. Metadata discovery and backend query planning still have their normal
resource behavior; this is not a bound on all internal working memory.

Browsing uses explicit `mode: "page"` with an integer `offset` from 0 to
1,000,000 and a deterministic ORDER BY. It returns at most `maxRows` rows,
`pageComplete: true`, `hasMore`, `offset` and `nextOffset`; `resultComplete` is
always **false**. The extra row is only a continuation witness. A byte-bound
failure still returns an error. Decision consumers must use complete mode and
must reject paged responses. Offset paging is not a snapshot: concurrent graph
updates can move entries between pages. Browse counts and pages must not be
used as proof of complete recovery, absence or an atomic authorization snapshot.

The deadline is 1–2,000 ms. Cancellation propagates through authority checks,
store admission and store reads. It is best effort on synchronous embedded
backends, which may only observe an abort after returning. Disconnects stop
queued/in-flight cancellable work. Deadline failures return 503
`QUERY_DEADLINE_EXCEEDED`; other unavailability retains the existing typed
store/authority errors or 503 `QUERY_UNAVAILABLE`.

Strict denial is applied at the agent's actual admission decision, via
`accessDenied: error`. It does not use a separate precheck that can disagree
with the subsequent query. Existing agent callers retain `accessDenied: empty`.
Strict denial returns 403 `QUERY_ACCESS_DENIED` and does not distinguish graph
absence from unreadability. The agent's normal query diagnostic omits the query
text when `redactQuery` is set by this route.

A successful response includes a request identifier and completion timestamp:

```json
{
  "version": 1,
  "queryId": "opaque-request-id",
  "observedAt": "2026-10-09T00:00:00.000Z",
  "contextGraphId": "example",
  "coverage": "local-only",
  "resultComplete": true,
  "result": {"type": "bindings", "bindings": []}
}
```

The identifier and timestamp are diagnostics, not a snapshot version or proof.
This endpoint does not claim chain-finalized graph completeness, an atomic
snapshot across multiple queries, negative global evidence, or verified rule
semantics. Consumers must constrain their own query to the appropriate memory
layer and evidence; authority to read a CG is not authority to treat all its
SWM/VM entities as verified application rules. No query cache is introduced.

Release validation must build the CLI, agent and query packages together. A new
CLI linked to an older agent is not a supported deployment of this capability.
Consumers should opt in only after installing that package release and completing
representative correctness and performance validation.
