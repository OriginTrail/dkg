# @origintrail-official/dkg-marketplace

Pure domain logic for the OT-RFC-27 NeuroSymbolic Marketplace prototype:
shared authorization/receipt digests (byte-for-byte mirrors of the
`Marketplace.sol` preimages), session-key lifecycle, the buyer-side
marketplace router, buyer metering (bigint bucket accounting with the RFC's
soft ceiling), the seller-side receipt batcher, and receipt build/verify
helpers.

No daemon or workspace imports — only `ethers` and the Node standard
library — so both the agent runtime and tests (including the Solidity test
suite, via the fixed digest vectors) can depend on it without pulling in
runtime infrastructure.

All TRAC values are wei (`bigint`); units (tokens / query units) are
`bigint` capped to `uint64`. No floating point is used for value math.

## Sellers + buyer gateway domain

The buyer/seller-facing layer ported from the private fork ("Prototype 5"),
re-shaped onto the RFC protocol (see
`agent-docs/plans/2026-10-27-rfc27-sellers-gateway.md`):

| Module | What it holds |
|---|---|
| `model-id.ts` | `canonicalModelId` (NFC → trim → lowercase, `MODEL_ID_PATTERN`), `inferModelFamily` |
| `token-engines.ts` | Pinned count engines: `hf-bpe-v1` (HF `tokenizer.json`), `tiktoken-o200k-v1` (`.tiktoken` ranks), `stub-words-v1` (devnet). Pin digest = `sha256:` of the one file the engine loads. `TokenizerRegistry` |
| `bpe-core.ts` (internal) | O(n log n) merge loop: linked symbol list + min-heap keyed `(rank, position)` with lazy invalidation. The fork's O(n²) loops survive only as a test oracle (`test/oracle-bpe.ts`) |
| `chat-messages.ts` | OpenAI message/tool normalization (idempotent through JSON, lone surrogates refused), tool-call policy, prompt-tool transport (`__dkg_tool_calls__`) |
| `chat-metering.ts` | Template `openai-chat-count/v1`, `meterChat`, `chatPromptUpperBound`, `boundCompletion`, `TOOL_CALL_SLACK_UNITS` |
| `query-cost.ts` | Integer `QUERY_COST_SCHEDULE_V1` + digest, verbatim `analyzeQuery`, admission/delivery/worst-case units, `queryRowCap`, the 8 KiB SPARQL size gate |
| `serve-wire.ts` | Chat payload/result and query result JSON shapes inside the unchanged serve envelope, strict total parsers |
| `recount.ts` | Buyer recount verdicts (`recountChat`, `recountQuery`) and the local `SellerStandingBook` |
| `gateway-keys.ts` | `dkg_gw_…` scoped keys hashed at rest: `GatewayKeyLedger` (timing-safe auth, wei budget reservations), `SlidingWindowRateLimiter` |
| `stream-chain.ts` | Frame-chain commitment for the deferred end-to-end streaming phase (no consumer yet) |

Tokenizer files are operator-supplied; tests use the tiny synthetic fixtures
in `test/fixtures/` and pin their counts and digests. `queryUnits` (the
placeholder `10 + ceil(bytes/100) + rows` schedule) is deprecated in favour of
the query cost schedule.
