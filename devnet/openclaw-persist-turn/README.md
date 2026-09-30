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
- two sessions that reuse one `turnId` are kept apart: each is created, completed
  and retried on its own, so one session's stored state never turns another's
  completion into a duplicate;
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
through `packages/cli/test/_helpers/chat-turn-footprint.ts`; they find a turn
through its session link and `turnId`, so they read a turn the same whether it
sits under a session-scoped subject (what the current code writes) or under the
older `urn:dkg:chat:turn:<turnId>` one. This suite supplies only its own
transport (`POST /api/query`) and result-cell shape.

A write that returned 200 is durable (the route awaits the store write), but an
external SPARQL store may serve a read a beat behind it. Stopping at the first
read that shows the expected one-exchange footprint would therefore pass on a
stale snapshot while the extra writes of a broken resend path are still on their
way to becoming visible. Every footprint check instead waits for the expected
footprint and then requires it to stay identical for a quiet window (2 s and at
least 3 further reads, `FOOTPRINT_SETTLE` in `settle.ts`); a read that differs
after the first match fails the test with that late footprint. The window
narrows the gap, it does not close it: a store that lags for longer than 2 s is
not caught. The polling logic is pure and is unit-tested without a devnet in
`settle.test.ts`, which `vitest.config.ts` runs together with the live suite.

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

Every test writes only turns of its own random sessions and turn id into the
node's own `agent-context` / `chat-turns` assertion. It never touches the shared
`devnet-test` context graph, a node wallet or the chain, and needs no funds.
There is no API to delete a chat turn, so the turns remain in the node data until
`./scripts/devnet.sh clean`.
