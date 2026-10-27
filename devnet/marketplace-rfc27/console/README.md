# OT-RFC-27 marketplace — devnet test console

A browser console for testing the RFC-27 NeuroSymbolic Marketplace prototype from
both sides on a local 6-node devnet: **Buyer (node 2)**, **Seller A (node 1)** and
**Seller B (node 3)**. It is devnet test tooling, not product code:

- `server.mjs` is a zero-dependency Node HTTP server. It uses `node:http`, plus
  `ethers` for chain reads and writes.
- `public/` is the static page. It is vanilla JS, has no build step, and
  needs no CDN.

## Prerequisites

```bash
pnpm build                                  # once, on this branch
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
node devnet/_bootstrap/bootstrap.cjs        # identities + stake
./scripts/devnet.sh status                  # all 6 nodes RUNNING
```

Chat offerings need the devnet **llm-stub**, a deterministic OpenAI-compatible
upstream (`../llm-stub.mjs`): its reply and its token usage are pure functions
of the prompt. Run it in its own terminal and leave it running:

```bash
LLM_STUB_API_KEY=devnet-stub-key pnpm devnet:marketplace:llm-stub   # http://127.0.0.1:18080/v1
```

`LLM_STUB_PORT` changes the port (the seeder and the console read the same
variable).

You need Node 22 and the `ethers` dependency of `devnet/marketplace-rfc27`
(`pnpm install`).

## Commands

```bash
pnpm devnet:marketplace:llm-stub   # the chat upstream (needs LLM_STUB_API_KEY=devnet-stub-key)
pnpm devnet:marketplace:seed       # idempotent setup (below); --mint-key also mints a gateway key
pnpm devnet:marketplace:console    # → http://127.0.0.1:9300/
```

### What the seeder does

`seed.mjs` is safe to rerun. The offering sets live in `devnet-offerings.mjs`
(the e2e suite and the console's "Load devnet defaults" use the same sets).

1. It checks the llm-stub (`GET http://127.0.0.1:18080/healthz`). When the
   stub is down it prints the command that starts it and seeds anyway:
   mounting a chat connector makes no upstream call, so the offers publish
   either way and chat calls work once the stub runs.
2. It writes each seller's stub secret file,
   `.devnet/node<n>/marketplace/.secrets/llm-stub.env` (file `0600`, folder
   `0700`) with `OPENAI_API_KEY=devnet-stub-key`. The offering config names
   only this path; the key never enters node config, offers, logs or status.
3. **Seller A** (node1) serves and publishes three offerings:
   - `devnet-llm`: inference, 0.5 µTRAC per token (the deterministic echo stub)
   - `devnet-knowledge`: SPARQL, 15 µTRAC per query unit, metered by the static
     query cost schedule (`dkg-mkt-query-cost/1`)
   - `devnet-chat`: OpenAI chat, model `stub-chat`, 0.5 µTRAC per token — an
     `openai-compatible` chat connector to the llm-stub, metered with the
     pinned `stub-words-v1` tokenizer, native tool calls
4. **Seller B** (node3) serves and publishes `devnet-llm` and `devnet-chat`,
   both at 0.8 µTRAC per token. The higher price checks routing: the buyer's
   router should pick A.

   Each offering is its own Knowledge Asset in Verifiable Memory. The seeder
   always sends the full set; the node leaves an unchanged offering alone (no
   transaction, logged as `unchanged`) and publishes a changed one as an
   on-chain update of the same KA. A rerun therefore also restores asks that
   were changed elsewhere.
5. It tops up the buyer's primary operational wallet by **100 TRAC**. It keeps
   the existing balance, and does this once per deployment.
6. It polls the buyer's `GET /api/marketplace/offers` until it sees all 5
   offers (a chat offer counts once its OpenAI-chat shape and tokenizer pin
   arrived too).
   - The buyer usually sees all three within about 10 s on a fresh devnet,
     including the first publish, which also anchors the `marketplace` CG
     on-chain. The default wait is 300 s.
   - Every poll also nudges the buyer's offer refresh.
7. It does **not** subscribe the buyer, because subscribing is part of the
   buyer experience.

Flags:

| Flag | Effect |
|---|---|
| `--subscribe` | Pre-subscribe the buyer with the console's default plan |
| `--force` | With `--subscribe`: re-subscribe even when already subscribed |
| `--topup-again` | Add another 100 TRAC |
| `--mint-key` | Mint a buyer gateway key on node 2 (budget 0.001 TRAC, model `stub-chat`) and print it **once** with a ready-to-run curl |
| `--timeout <s>` | Change the discovery wait |

### Server options (environment)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Non-loopback is refused unless an access key is set. |
| `PORT` | `9300` | Listen port |
| `CONSOLE_ACCESS_KEY` | (unset) | When set, every request needs the key (see below). Minimum 12 characters. |
| `DEVNET_RPC` | `http://127.0.0.1:8545` | Hardhat RPC |
| `DEVNET_DIR` | `<repo>/.devnet` | Devnet node homes |

The server reads each node's bearer token from `.devnet/nodeN/auth.token` (the
last non-comment line) and injects it on its side, so tokens never reach the
browser.

The server proxies only these node routes:

- `/node/<n>/api/marketplace/*` (GET and POST), with node n's token
- `/node/<n>/api/marketplace/gateway/v1[/…]` (GET and POST): the **buyer
  gateway**. Here the server forwards the *browser's* `Authorization` header
  (a gateway key) and never adds the node token, so the gateway sees exactly
  what an external OpenAI client would send. A node token on a gateway path is
  refused (401) by the node anyway. These calls get a 240 s proxy timeout (a
  chat call may wait up to 200 s for the seller's upstream).
- `GET /node/<n>/api/status`

A key mint answers `201` with the plaintext key; the server never records or
logs a mint response (it remembers only plan policies and offering sets).
`GET /console/llm-stub` reports whether the llm-stub answers.

#### Access key

To put the console behind a tunnel, set an access key:

```bash
CONSOLE_ACCESS_KEY=$(openssl rand -hex 16) HOST=0.0.0.0 pnpm devnet:marketplace:console
# open  http://<host>:9300/?key=<that key>   once
```

- `?key=` sets an `HttpOnly; SameSite=Strict` cookie, then refreshes to the
  clean URL.
- A request without the key gets a `401` with a one-line explanation.
- Scripts can send the key in an `X-Console-Key: <key>` header instead.

Without a key, the server binds loopback only. It also answers only loopback
`Host` headers, which guards against DNS rebinding.

On either setup, POSTs must be same-origin `application/json`.

### Chain endpoints

These are server-side ethers calls. Contract addresses are resolved through the
Hub.

| Route | Returns / does |
|---|---|
| `GET /chain/state` | Chain time (next-block estimate), wall time, current epoch, `settlementDeadline`, seconds left, params (λ, grace, soft-ceiling bps, reward-cap multiple), each recent epoch's pool, reward distribution and `phase` (`next`, `current`, `grace`, `ready` = deadline passed with buckets left to finalize, `settled` = every bucket finalized, `empty`). `settled` on a row only means "past the deadline" and is kept for scripts; prefer `pastDeadline` / `phase`. |
| `GET /chain/epoch/<e>` | Per-buyer buckets (`funded`, `totalClaimed`, `totalFinalized`, `finalized`) with per-seller claims (`claimed`, `qiRaw`, `enrolled`, pro-rata outcome). Per-node accounting (R_i, Q_i, ΣR, ΣQ, QIF from `getQif18` plus a bigint mirror). Expected reward = `min(pool·QIF/1e18, cap·R_i)`, a projection as if every open bucket were finalized now, and whether the reward is claimable |
| `GET /chain/nodes` | For nodes 1–6: role, API port, peer id, op wallets with TRAC/ETH, identityId |
| `POST /chain/warp` | **Devnet only.** `{seconds}` or `{toDeadline:true, epoch?}`. Uses `evm_increaseTime` + `evm_mine`. "To deadline" = `settlementDeadline(epoch) + 15 s − chainNow`, never negative. |
| `POST /chain/fund-buyer` | **Devnet only.** `{node, trac}` tops up the node's primary op wallet. It reads the balance and writes it back plus the amount (ERC-20 balance-slot write), keeping the existing balance. |
| `GET /console/state` | The plan policy and offering sets the console last sent. Node APIs don't echo them back, so they are kept in `.devnet/marketplace-console.json` and wiped by `devnet.sh clean`. |

## What each view does

**Network strip** (always visible; on a phone it collapses to one summary
row with a **Details** button):

- Chain time, current epoch, and the epoch you are viewing for settlement.
  Its state reads **Receipts open · deadline in …**, then **Receipts closed ·
  ready to finalize** after the deadline, and **Settled** only once every
  bucket is finalized. The epoch picker uses the same words.
- That epoch's pool and how many buckets are left to finalize, plus λ, the
  reward cap and the soft ceiling.
- If a chain refresh fails, a "Chain refresh failing · last good … ago" line
  appears; the values stay but are marked stale.

**Devnet time travel…** (a quiet button right of the perspective tabs) opens a
dialog. It states that time travel is irreversible and affects everyone on the
devnet, and lists what jumping to the viewed epoch's settlement deadline does
(the epoch ends, plans for it stop working with `SETTLEMENT_CLOSED`, receipts
can no longer land, buckets become finalizable). It offers **Jump +…** and
**+1 hour**. The panels that wait for the deadline (Finalize, the claim gate)
link to it.

**Buyer (node 2)**

- **Your plan & usage meter**:
  - Plan **Active**, **Ended** (its epoch is over: subscribe for the current
    one) or **None**. The session key (and whether it is registered
    on-chain), and the on-chain bucket: funded, claimed on-chain, and how
    much is still waiting for sellers to flush.
  - If node 2 lost its plan (restart) while a bucket for the current epoch
    exists on-chain, a recovery warning says so.
  - Used / remaining in µTRAC (the node's own one-line meter is one click
    deeper).
  - Per-bucket bars: settled (solid), reserved (hatched), and the
    **limit** marker (soft ceiling): the next call's worst case must end
    before it, i.e. stay within 95% of what is left.
  - "Usable until epoch N ends (in …) · receipts settle until the deadline
    (in …)".
- **Subscribe**:
  - Amount in TRAC, and current or next epoch.
  - Per-service buckets: budget in TRAC, price cap in µTRAC per unit, max
    units per call.
  - Optional seller deny list.
  - Every TRAC input shows its µTRAC equivalent (the unit the meter and
    settlement panels use). Conversion uses exact string/bigint math; tick
    "Show exact wei" for wei.
  - Disabled (with the reason) while node 2 does not answer. A wallet-balance
    shortfall is reported as **Not sent — checked in the browser**.
  - Once subscribed, deny-list edits are flagged "not applied yet" until you
    click **Add funds & replace plan**.
- **Offers on the network**:
  - The discovered offers: seller, which one the router would pick (and why
    the others lose), the discovered ask in µTRAC per unit, service and
    offering.
  - The router ranks on each seller's **live quote**, not on the discovered
    ask. When a seller's own node reports a newer ask (from the offering set
    the console published to it, or its own graph view, or a live quote seen
    in a call), the stale discovered ask is flagged and the preview ranks on
    the newer one.
- **Try it** (the node-admin `POST /api/marketplace/invoke` rail):
  - Choose Inference or SPARQL, then enter a prompt or a query
    (`SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5` is prefilled), and
    **Max units for this call** (`maxUnits`). Inference here reaches
    `devnet-llm` only: OpenAI-chat offers take gateway calls (step 5).
  - Before the call, it previews the router's pick and the worst case against
    the next-call limit, and warns about invalid max units, the bucket's
    per-call limit, and an ended plan.
  - **Run call** is disabled, with the reason shown, until you have a plan and
    while node 2 does not answer.
  - After the call it shows the result, served units, cost in µTRAC, the
    serving seller, and the receipt (authDigest, resultCommitment, seller
    signature, authorization, and your node's recount verdict) in a
    collapsible block. If the serving seller or its live ask differs from the
    preview, it says so.
  - Errors are explained in plain language with their code, for example
    `NO_ROUTE` with its rejections, `UNDERFUNDED`, `NOT_SUBSCRIBED`, or the
    soft ceiling.
  - "Probe soft ceiling" sets the smallest `maxUnits` that crosses the soft
    ceiling.
- **This session's calls**: the invoke history for this browser tab, in chain
  time (UTC). A call cut off by a reload or a lost connection is listed as
  **outcome unknown** (check the meter), not as a failure.
- **API keys & OpenAI gateway** (node 2's buyer gateway at
  `http://127.0.0.1:9202/api/marketplace/gateway/v1`):
  - Status: base URL (copyable), gateway enabled, keys on file, whether a plan
    is active (calls answer `not_subscribed` without one), and whether the
    llm-stub is up.
  - **Mint a key**: label, budget in µTRAC (wei shown), model allowlist
    (empty = any model), expiry, requests per second, and "Allow `/query`".
    The key is shown **once**, with a Copy button, and kept only in this page's
    memory until you reload or click **Hide**. Node 2 stores only its hash.
  - **Call it from code**: a curl, an OpenAI SDK (JS) and an OpenAI SDK
    (Python) snippet. The key is filled in only right after a mint; otherwise
    the snippets read `DKG_GATEWAY_KEY`.
  - **Keys on node 2**: each key's state (active, expired, revoked), budget,
    spent, left (budget − spent − held for calls in flight), calls and units,
    and scope. **Revoke** asks for a second click; the key's next call answers
    `401 key_revoked`.
  - **Try chat through the gateway**: paste a key (or use the one just
    minted), pick the model, optionally set max tokens and a system message,
    and tick Stream for a buffered SSE reply. The result shows the reply,
    usage, the serving seller and cost, the metering pin, your node's recount
    verdict, and the key's remaining budget. Refusals are explained by their
    gateway code (`key_budget_exceeded`, `model_not_allowed`,
    `not_subscribed`, `upstream_error`, …) with what, if anything, was
    charged.
- **Settlement**:
  - The bucket's funded, claimed and finalized amounts, and each seller's
    pro-rata outcome (a preview before finalization).
  - **Finalize my bucket** is enabled only after the deadline.

**Seller A (node 1) and Seller B (node 3)**

- **Seller node**: seller readiness, offerings served, pending receipts,
  submitted claims, chat connectors mounted (and failed), op wallet,
  identity, peer id, TRAC.
- **Offerings**:
  - Add, edit or remove offerings (ask in µTRAC per unit, with the wei value
    shown), then **Publish**.
  - **In the marketplace graph** lists this node's own offers and what buyer
    node 2 sees for each (same ask / still sees the old ask / not discovered).
    An update usually reaches node 2 within seconds, at most about a minute
    later. If it has not after 2 minutes (3 for a first discovery), a warning
    says where to look.
  - The publish result counts offerings published on-chain and offerings left
    unchanged (no transaction).
  - A chat-connector row (`devnet-chat`) shows its connector kind, upstream
    model, tokenizer pin and tool transport. Its service and unit are fixed;
    its connector config (from the seeder) is sent back unchanged when you
    publish. An OpenAI-chat offer found only in the graph cannot be
    republished from here (its upstream URL and secret file are never
    published): use **Load devnet defaults**.
- **Chat connectors** (`GET /api/marketplace/seller/connectors`): per
  connector offering, its kind and upstream **origin** (never the full URL),
  state (mounted, mounting, failed + why), whether a secret is configured,
  and the metering pin (tokenizer kind and digest). **Probe upstream health**
  calls each upstream's `/models` with the node's secret (no spend) and shows
  the result and latency.
- **Receipts**: **Flush receipts now**. It shows the batch, claim, requeued
  and failed counts.
- **Claims on-chain**:
  - This seller's claim per buyer in the viewed epoch: claimed, final value
    (marked "pro-rata if finalized now" until the bucket is finalized),
    bucket state, share of the bucket, and stake-weighted value.
  - A permissionless **Finalize** button appears for open buckets after the
    deadline.
- **Epoch reward**:
  - R_i, Q_i, the shares, λ, and the QIF breakdown.
  - Pool and expected reward, `min(pool·QIF, cap·R_i)`. Values are
    *projected* until every bucket is finalized.
  - A claim gate checklist, including "this node has finalized receipt
    value (R_i > 0)"; a seller that served nothing is told there is nothing to
    claim.
  - **Claim reward** is enabled only when every gate is green. After
    claiming, it shows the amount paid and the op-wallet change.
  - When a seller has served nothing yet, Receipts and Claims explain why
    (a cheaper seller wins the router) and how to route calls to it.

Every panel has loading, empty, error and success states. The status panels
refresh every 5 s and pause while the tab is hidden. When a refresh fails
after data has loaded, the panel keeps the last good data under a **Refresh
failing** banner, and its header reads "refresh failing · last good … ago".

All amounts are bigint wei. Each panel or table uses one unit for all its
amounts (µTRAC while everything in it is below 1 TRAC); wallet balances are
always TRAC. Hover or click any amount, or tick **Exact wei** in the header, to
see the exact wei value. The theme follows the OS setting, and you can force
it with Auto / Light / Dark.

## Buyer gateway from a terminal

The gateway is an OpenAI-compatible API on the buyer node, so any OpenAI
client works against it. Keys come from the console's **API keys** panel,
`pnpm devnet:marketplace:seed --mint-key`, or `dkg marketplace keys mint`;
calls need an active buyer plan (subscribe first).

```bash
export DKG_GATEWAY_KEY=dkg_gw_…              # shown once, at mint
BASE=http://127.0.0.1:9202/api/marketplace/gateway/v1

curl $BASE/models -H "Authorization: Bearer $DKG_GATEWAY_KEY"
curl $BASE/chat/completions -H "Authorization: Bearer $DKG_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"stub-chat","messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"hello marketplace world"}]}'
curl $BASE/query -H "Authorization: Bearer $DKG_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sparql":"SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5","max_rows":100}'
```

Every response carries a `dkg` block: the serving seller, units, cost, the
seller-signed receipt, the metering pin, your node's recount verdict and the
key's spend. Only the `Authorization: Bearer` header carries the key; a node
token is refused there, and a gateway key opens no other route.

The e2e suite runs the same arc with assertions (`pnpm
test:devnet:marketplace-rfc27 -t gateway`, steps G1–G15); it starts its own
in-process stub and needs no standalone one.

## Suggested walkthrough

1. Run `pnpm devnet:marketplace:seed`, then `pnpm devnet:marketplace:console`.
   Open the console on the **Buyer** tab.
2. **Offers**: three offers are listed. "Router pick" marks the cheapest
   `devnet-llm` (Seller A at 0.5 µTRAC on a fresh seed) and A's
   `devnet-knowledge`.
3. **Subscribe** with the prefilled plan:
   - 0.01 TRAC of funding.
   - Inference: 0.006 TRAC, cap 1 µTRAC per token, up to 16,000 units per
     call.
   - Query: 0.004 TRAC, cap 20 µTRAC per query unit, up to 200 units per
     call.

   The plan panel shows the bucket funded on-chain and the session key
   registered.
4. **Try it → Inference** with max units 1000. The seller the preview picked
   serves. Open "Receipt & authorization".
5. **Try it → SPARQL query** with max units 50. Seller A serves 3 or 4 query
   units (admission 3 + 1 per 100 rows).
6. Watch the **meter**: the settled share grows, and the **limit** marker
   and "next-call limit" move.
7. **Probe soft ceiling → Run call**. Your node refuses the call locally
   (`NO_ROUTE · no-eligible-offer`, rejection `soft-ceiling`). Nothing is
   reserved or charged.
8. *(optional)* Re-subscribe with Seller A on the deny list ("Add funds &
   replace plan"). Inference then routes to Seller B.
9. **API keys → Mint key** with the defaults. Copy the key, then
   **Try chat** → Send: Seller A serves `STUB:WORLD MARKETPLACE HELLO :: ok`,
   17 + 5 = 22 tokens × 0.5 µTRAC = 11 µTRAC, recount **match**. Tick Stream
   and send again: the same reply and units as SSE. Copy the curl snippet into
   a terminal for the same call from outside the browser. **Revoke** the key:
   the next call answers `401 key_revoked`.
10. **Seller A tab → Flush receipts now**. **Claims on-chain** shows the claim
   against the buyer's bucket. Receipts also auto-submit about 15 s after
   serving. **Epoch reward** shows the projected QIF and reward. With a tiny
   pool, the 10 × R_i cap usually decides the amount.
11. **Devnet time travel… → Jump** to the settlement deadline. This affects
    everyone on the devnet. The strip turns to "Receipts closed · ready to
    finalize", and the buyer's plan shows **Ended**.
12. **Buyer tab → Settlement → Finalize my bucket**. The pro-rata outcome
    becomes final.
13. **Seller A tab → Claim reward**. All claim gates are green, and the
    panel shows the amount paid. Repeat on **Seller B** if B served anything
    (otherwise its gate says there is nothing to claim). Subscribe again to
    keep testing in the new epoch.

Notes:

- Nodes refresh their view of chain time about every 30 s. Right after time
  travel, a new call can be refused as `STALE_AUTHORIZATION` or `EXPIRED`;
  wait and retry.
- After the epoch rolls over, the old plan's seller refuses calls with
  `SETTLEMENT_CLOSED`. Subscribe again for the current epoch.
- The buyer's plan and meter live in the node's memory. If node 2 restarts,
  subscribe again; the funds already in the on-chain bucket stay.

## Known issues (outside the console)

- **Fixed: republished offers did not reach other nodes.** Each (seller,
  offering) is now one Knowledge Asset in Verifiable Memory, and a changed
  ask is an on-chain update of that same KA. Right after the publish every
  node briefly holds the new ask in shared memory (for about 1–3 s); a node
  whose discovery runs then shows it at once (the console's refresh after
  **Publish** usually does). Otherwise a node shows it once it applies the
  update from the chain: on the devnet about 10–25 s on the edge nodes and
  about 50–60 s on the core nodes that signed the update, buyer node 2
  included. A node's discovery never lists the old and new ask together and
  never goes back to an older ask once it has shown a newer one. The
  buyer-side stale flag and the seller-side "Not propagated" warning stay as
  signals for an update still in flight or stuck.
- **Expected log noise.** Each offer publish still logs `SWM substrate
  fan-out … rejected=…` on the seller and `legacy SWM apply is not
  authoritative for root scope of context graph "marketplace"` on the other
  nodes. The KA's shared-memory copy is also offered over the legacy SWM
  lane, which nodes that hold the graph's RFC-64 catalog decline; they take
  the offer from the catalog and the chain instead. Any KA published into a
  registered context graph does the same (for example the bootstrap's
  `devnet-test` publishes).
- **Removing an offering does not unpublish it.** A seller that drops an
  offering from its set stops serving it, but its offer KA stays in the
  graph. Buyers still discover it and the seller's live quote declines it;
  the console marks it "no longer serves this offering".
