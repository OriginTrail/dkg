# V9 Testnet Faucet

Fund your DKG V9 node wallets with Base Sepolia testnet ETH and TRAC in a single API call.

**Base URL:** `https://euphoria.origin-trail.network/faucet`

## Fund wallets

Send a `POST /fund` request with your node wallet addresses (up to 4 per call). Each wallet receives both Base Sepolia ETH and test TRAC.

```bash
curl -X POST "https://euphoria.origin-trail.network/faucet/fund" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-001" \
  --data-raw '{
    "mode": "v10_base_sepolia",
    "wallets": ["0xYOUR_WALLET_ADDRESS"]
  }'
```

### Request body

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | Yes | Must be `"v10_base_sepolia"` |
| `wallets` | Yes | Array of EVM addresses (1-4, no duplicates) |
| `callerId` | No | Stable identifier for your installer/node; enables per-caller cooldown. Bundled setup commands omit this field and rely on `Idempotency-Key` for retry safety. |

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | Recommended | Unique string per funding operation. Retrying with the same key + body returns the cached result instead of double-funding. |

### Response

```json
{
  "requestId": "uuid",
  "results": [
    { "chainId": "v9_base_sepolia_eth",  "address": "0x...", "status": "success", "txHash": "0x...", "amount": "0.001" },
    { "chainId": "v9_base_sepolia_trac", "address": "0x...", "status": "success", "txHash": "0x...", "amount": "10000" }
  ],
  "summary": { "total": 2, "success": 2, "failed": 0 }
}
```

Each wallet produces 2 result entries (ETH + TRAC). Possible `status` values: `success`, `failed`, `cooldown_active`.

## Rate limits and cooldowns

| Limit | Value |
|-------|-------|
| Global API rate limit | 10 requests / 15 min per IP |
| Funding rate limit | 3 calls / 8 hours per IP (shared with `/dry-run`) |
| Wallet cooldown after success | 12 hours (per wallet) |
| Wallet cooldown after failure | 30 seconds |

On `429` responses, back off using the `retry-after` header.

Bundled setup commands such as `dkg init`, `dkg openclaw setup`, `dkg hermes setup`,
and `dkg mcp setup` do not send `callerId` because caller cooldown can otherwise
block later wallets in the same 4-wallet funding request. They still send a
deterministic `Idempotency-Key` derived from the node/agent name and wallet batch
so retrying the same funding operation remains safe.

Bundled setup commands wait up to 3 minutes for a faucet response because a
4-wallet request can broadcast both ETH and TRAC transactions for each wallet
before the faucet returns. If the client still times out, check wallet balances
before retrying because the faucet may finish the on-chain work after the local
request is aborted.

## Dry run (test without sending transactions)

`POST /dry-run` accepts the same body but doesn't broadcast transactions. Use it to verify your request while avoiding on-chain transactions; note that dry-run requests still count against the shared funding rate limit.

```bash
curl -X POST "https://euphoria.origin-trail.network/faucet/dry-run" \
  -H "Content-Type: application/json" \
  --data-raw '{"mode": "v10_base_sepolia", "wallets": ["0xYOUR_WALLET_ADDRESS"]}'
```

## Look up a previous result

```bash
curl "https://euphoria.origin-trail.network/faucet/requests/REQUEST_ID"
```

## Common errors

| Code | Meaning |
|------|---------|
| `400 VALIDATION_ERROR` | Invalid address, missing fields, or bad request shape |
| `409 IDEMPOTENCY_CONFLICT` | Same idempotency key reused with a different request body |
| `429 RATE_LIMITED` | Rate or funding limit exceeded — check `retry-after` header |

## Quick checklist

1. Call `GET /health` to verify connectivity.
2. Send `POST /fund` with `mode: "v10_base_sepolia"` and your wallet(s).
3. Always include an `Idempotency-Key` header to safely retry on network failures.
4. Check `results[]` — individual wallets can succeed or fail independently.
5. Back off on `429` using the `retry-after` header.
