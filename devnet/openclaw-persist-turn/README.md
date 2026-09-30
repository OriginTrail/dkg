# openclaw-persist-turn - devnet regression

Live devnet coverage for `POST /api/openclaw-channel/persist-turn` idempotency.

## What it proves

The route hands each turn to the daemon-wide durable-turn owner
(`persistDurableChatTurn`, shared with Hermes and Prime Agent). Against real
daemons, over HTTP with the node's bearer token, the suite checks that:

- a new `(sessionId, turnId)` writes exactly one user/assistant exchange into the
  `'chat-turns'` Working Memory assertion of the node's `agent-context` graph;
- sequential and concurrent resends of the same turn answer
  `{ ok: true, duplicate: true, turnId }` and add nothing to the store;
- `pending` -> `stored` is recorded as one transition (the final assistant reply
  rides on it) instead of a second exchange, and a late `failed` report after
  `stored` is a duplicate, never a downgrade;
- a POST without a `turnId` still writes every time, under a generated id that
  the response returns so the caller can retry idempotently;
- an invalid payload answers 400 and writes nothing;
- the Hermes and Prime Agent persist-turn routes behave the same on resend and
  upward transition (parity regression: no existing devnet suite covered them).

The store is read back through `POST /api/query` (`view: working-memory`,
`assertionName: chat-turns`). Duplication shows up as extra `schema:Message`
subjects carrying the turn id, extra `hasUserMessage` / `hasAssistantMessage`
objects on the turn, and extra transitions; the suite counts those. The footprint
queries are shared with the CLI e2e (`packages/cli/test/openclaw-persist-turn.e2e.test.ts`)
through `packages/cli/test/_helpers/chat-turn-footprint.ts`; this suite supplies
only its own transport (`POST /api/query`) and result-cell shape.

It runs against nodes 1, 3 and 5, which sit on different store backends
(managed `oxigraph-server`, `blazegraph`, `sparql-http` to an external Oxigraph
when Docker provisions them; otherwise the devnet falls back as described in
`scripts/devnet.sh`). The backend of each node is printed at the start of the run.

## Run

```bash
pnpm run build
pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:openclaw-persist-turn
```

## Side effects

Every test writes only turns of its own random session and turn id into the
node's own `agent-context` / `chat-turns` assertion. It never touches the shared
`devnet-test` context graph, a node wallet or the chain, and needs no funds.
There is no API to delete a chat turn, so the turns remain in the node data until
`./scripts/devnet.sh clean`.
