# Buy AI inference through your DKG node — NSM v3 buyer tutorial

You already run a DKG V10 node on Base mainnet. This tutorial takes you from
that node to **purchasing metered inference** — including the `gpt-5.4` ☁
offering — from the NSM v3 seller, with every charge independently recomputed
on your own machine before you agree to pay it.

Everything below is the exact path a real buyer node completed on
2026-08-17 (deposit tx `0xe3917be3…`, three countersigned legs). Where the live
run hit a rough edge, the workaround is included.

**How it works in one paragraph:** offerings are knowledge assets on a public
context graph (`nsm-live`). You subscribe your node to it, and from then on
*everything* — price quote, tab opening, inference calls, receipts — travels as
signed knowledge assets over DKG gossip between your node and the seller's.
There is no API endpoint to reach, no VPN, no token from the seller. You talk
only to your own node; the graph does the rest. Money is real TRAC on Base:
you deposit once into a tab, spend µTRAC per token, and the untouched remainder
stays refundable.

> **Scope note (☁ offering):** the `gpt-5.4` offering is backed by the
> operator's own subscription and is **limited to team-authorized buyers** —
> ask the operator before buying it. The ⛓ `Qwen2.5-14B` offering has no such
> restriction. The mechanics below are identical for both.

---

## 0. What you need

| Requirement | Notes |
|---|---|
| DKG V10 node on Base mainnet | v10.0.12+ (v10.0.13 stock runtime verified live) |
| Node.js 20+ / pnpm | to build the marketplace package |
| A **buyer wallet** on Base | ~1 TRAC + a little ETH for one gas fee. **Never your node's operational wallet.** |
| ~15 minutes | one node restart included |

Prices you'll be paying (from the signed quote — you'll verify these yourself
in step 4): ☁ `gpt-5.4` = 3 µTRAC/input token + 9 µTRAC/output token;
⛓ `Qwen2.5-14B` = 2/6; metered query = 5 flat + 1/returned row. A typical
completion costs **200–300 µTRAC ≈ $0.0001**. Your 1 TRAC deposit is 1,000,000 µTRAC.

## 1. Get the build

```bash
git clone https://github.com/OriginTrail/dkg.git && cd dkg
git checkout prototype/nsm-marketplace-v3
pnpm install
pnpm --filter @origintrail-official/marketplace build
# optional but recommended — the Marketplace/Operate node-UI views:
pnpm --filter @origintrail-official/dkg-node-ui build:ui
```

Record `git rev-parse HEAD`. If the seller publishes a parity SHA, compare —
your recount must run the same arithmetic the seller meters with.

## 2. Mount the buyer module on your node

Two small config changes, then one restart.

**a.** In your node's `config.json`, add (absolute path to *your* clone):

```json
"routePlugins": ["/abs/path/dkg/packages/marketplace/dist/plugin.js"]
```

**b.** Create `$DKG_HOME/marketplace/config.json`:

```json
{ "enabled": true, "offerings": [] }
```

(`offerings: []` = buyer-only. You are not selling anything; no seller routes
appear on your node.)

**c.** Restart your node. Confirm the plugin loaded:

```
grep "route-plugins-loaded" <your node log>     # expect loaded=1
```

If you built the UI: install `packages/node-ui/dist-ui/` over your runtime's
served UI directory, then open `http://127.0.0.1:<apiPort>/ui?marketplace=1` —
**Marketplace** and **Operate** appear in the left nav. (The `?marketplace=1`
flag persists after the first visit.)

## 3. Join the market — subscribe to the graph

```bash
TOKEN=$(tail -1 $DKG_HOME/auth.token)
curl -X POST http://127.0.0.1:<apiPort>/api/context-graph/subscribe \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"contextGraphId":"nsm-live"}'
```

`nsm-live` is public — no invitation needed. Sync takes seconds (it's a small
graph). Verify the offerings resolve **from your own node**:

```bash
curl -X POST http://127.0.0.1:<apiPort>/api/query \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sparql":"PREFIX nsm: <https://w3id.org/neurosymbolic-marketplace/nsm#> SELECT ?m ?pc WHERE { GRAPH ?g { ?o a nsm:ModelOffering ; nsm:modelId ?m ; nsm:provenanceClass ?pc } }","contextGraphId":"nsm-live","includeSharedMemory":true,"includeContextGraphPartitions":true}'
```

Expected: `gpt-5.4` (`upstream-claimed`) and `Qwen2.5-14B-Instruct-Q4_K_M`
(`weights-pinned`). The Marketplace UI view shows the same, badged ☁/⛓.

## 4. Fetch and verify the signed quote

Put your buyer wallet key in a file **outside any git tree** (mode 600):

```bash
# $DKG_HOME/marketplace/.secrets-buyer-wallet.env
BUYER_WALLET_KEY=0x<your buyer wallet private key>
```

Then, from your clone, run the quote check over the lane:

```js
// save as check-terms.mjs, run: node check-terms.mjs
import { LaneBuyerClient } from "./packages/marketplace/dist/lane/client.js";
const buyer = new LaneBuyerClient(
  "http://127.0.0.1:<apiPort>",           // YOUR node
  "<your node auth token>",
  "nsm-live",
  "<abs path to .secrets-buyer-wallet.env>",
);
const t = await buyer.terms();            // travels over DKG gossip, ~5-15s
console.log(JSON.stringify(t.body.quote, null, 2));
console.log("providerPublicPem:\n" + t.body.providerPublicPem);
```

Check, and refuse to proceed if any fails:
- `providerAddress` is `0x633E5a7C5e612d9981538F60D824cC03be97e2Ab`, `chainId` 8453
- `providerKeyId` is `ed25519:73590f0c709a7314` and the PEM you received matches
  what the operator published out of band (unverifiable ≠ pass)
- the ☁ offering pins `countingBundleSha256:
  446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d` — that's
  the public `o200k_base` bundle; fetch and verify your own copy:

```bash
curl -sLO https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken
shasum -a 256 o200k_base.tiktoken   # must equal 446a9538cb6c…
```

That file is your **recount engine's** input — the seller bills `gpt-5.4` by
counting under exactly this bundle (input = template-constants arithmetic,
output = BPE of the delivered bytes), so your recount matches an honest bill
*exactly*, and any drift is a provable violation.

## 5. Deposit once, open your tab

Send **1.0 TRAC** (ERC-20 `transfer`, contract
`0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23`) from your buyer wallet to the
provider address, on Base. Use any wallet tool you trust. Save the tx hash.

```js
const r = await buyer.openTab("0x<your tx hash>");
console.log(r.status, r.body);            // 200 + { tab: { tabId: "tab_…" } }
```

The seller verifies your deposit on **its own** RPC and consumes the hash — a
second `openTab` with the same hash returns 409 forever. Your `tabId` is your
account; only your depositing wallet's signature can spend from it.

## 6. Configure your gateway + mint yourself a key

Write `$DKG_HOME/marketplace/buyer.json`:

```json
{
  "sellerApiBase": "lane://nsm-live",
  "walletEnvFile": "/abs/$DKG_HOME/marketplace/.secrets-buyer-wallet.env",
  "tabId": "tab_<from step 5>",
  "offerings": [
    {
      "id": "codex-cloud", "modelId": "gpt-5.4", "provenanceClass": "upstream-claimed",
      "tokenizerBundleRef": "public:o200k_base",
      "providerPublicPem": "<the PEM you pinned in step 4>",
      "perInputTokenMicroTrac": 3, "perOutputTokenMicroTrac": 9,
      "queryFlatMicroTrac": 5, "perReturnedQuadMicroTrac": 1,
      "bundlePath": "/abs/path/o200k_base.tiktoken", "bundleKind": "tiktoken"
    }
  ]
}
```

Mint a spending key on your own loopback (budget-capped, revocable, never your
wallet key):

```bash
curl -X POST http://127.0.0.1:<apiPort>/marketplace/gateway/v1/keys \
  -H 'content-type: application/json' \
  -d '{"budgetMicroTrac":100000,"rps":10,"allowQuery":true}'
# → { "key": "nsm_k_…" }   ← shown once, save it
```

## 7. Buy an inference from gpt-5.4

```js
const r = await buyer.chat("gpt-5.4",
  [{ role: "user", content: "In one sentence, why do knowledge graphs matter?" }], 128);
const leg = r.body.nsm.leg;
const text = r.body.choices[0].message.content;
console.log(text);
console.log("billed:", leg.pricing.costMicroTrac, "µTRAC");
```

The request travels as a signed KA through the graph; the seller's node serves
it against the upstream and returns a **signed leg**: token counts, price,
byte-digest of exactly what you received, tokenizer pin, provider signature.

**Recount before you pay** (the whole point):

```js
import { verifyInferenceLegV3 } from "./packages/marketplace/dist/buyer/recount.js";
import { tiktokenEngine } from "./packages/marketplace/dist/buyer/bpe.js";
import { readFileSync } from "node:fs";
const verdict = verifyInferenceLegV3({
  leg, deliveredBytes: Buffer.from(text, "utf8"),
  promptMessages: [{ role: "user", content: "In one sentence, why do knowledge graphs matter?" }],
  offering: { tokenizerBundleRef: "public:o200k_base", providerPublicPem: "<pinned PEM>",
              perInputTokenMicroTrac: 3, perOutputTokenMicroTrac: 9 },
  engine: tiktokenEngine(readFileSync("o200k_base.tiktoken", "utf8")),
  provenanceClass: "upstream-claimed",
});
console.log(verdict.decision, verdict.violations);   // "countersign", []
if (verdict.decision === "countersign") await buyer.countersign(leg.legId);
else await buyer.withhold(leg.legId, verdict.violations[0].code, verdict.violations[0].detail);
```

All five checks pass → `countersign` (you accept the charge). Any single
failure → `withhold` with the exact violation code — you never pay a charge you
can't reproduce. (If you go through the gateway with your `nsm_k_` key instead,
this recount runs automatically in-path.)

## 8. Close when you're done

```js
const c = await buyer.close();      // all legs must be decided first
console.log(c.body.quantities);     // billed vs balance — remainder stays refundable
```

Below the settlement threshold the seller *cannot* pay itself from your tab;
your unspent balance remains yours.

---

## Troubleshooting (from the live run)

| Symptom | Cause / fix |
|---|---|
| Lane call takes 10–20 s | Normal — that's DKG gossip round-trip, not an error. |
| No response after ~5 min | Send a **fresh** request (new correlation). The seller's executor retries deliveries 6×, but if your first request is ever billed-yet-undelivered, ask the seller in your coordination channel to **late-deliver** it under the original correlation — serving is deterministic, so the redelivered bytes hash-match the leg and you can countersign honestly. Never countersign or withhold a leg whose bytes you don't hold. |
| `subscribe` → 403 allowlist error | You subscribed a *curated* graph. The market graph `nsm-live` is public; check the id. |
| Marketplace UI empty but API resolves offerings | Your UI bundle predates `51f66a15` — rebuild `build:ui` and reinstall. |
| Node won't start after mounting the plugin | Check `routePlugins` path is absolute and the package is built (`dist/plugin.js` exists). |
| `E_TXHASH_CONSUMED` on openTab | That deposit already opened a tab — reuse the tabId, don't redeposit. |

## What you just used

Every step above ran on the **NSM v3 protocol**: discovery = knowledge assets,
transport = SWM gossip (`lane/`), auth = EIP-191 over
method+path+body+tab+nonce, metering = signed legs, and the buyer veto =
`recount.ts` with five violation codes. Source:
`packages/marketplace/` on branch
[`prototype/nsm-marketplace-v3`](https://github.com/OriginTrail/dkg/tree/prototype/nsm-marketplace-v3).
