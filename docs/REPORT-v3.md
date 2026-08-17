# NSM v3 — Evidence Report

*NeuroSymbolic Marketplace, iteration 3. Seller device = okf-mainnet (Base
mainnet). Compiled from live reads, the devnet two-seat run, and the branch
build. Every figure is a real capture; where a step has no UI it is marked;
what is not achieved is stated plainly.*

> **STATUS: FUNDED RUN COMPLETE — 2026-08-17.** Hermes's buyer node (his own
> device, stock 10.0.13 runtime + the branch buyer module) deposited 1.0 TRAC on
> Base mainnet, bought ⛓ local inference, ☁ resold-subscription inference
> (gpt-5.4), and a metered knowledge query — entirely over DKG SWM gossip, no
> VPN, no endpoint URL — recounted every charge, countersigned all four legs,
> closed the tab, and posted a receipt bundle that **cross-verifies 17/17**
> against the seller ledger. Both seats independently compute
> **1,000,000 = 761 + 999,239**. Awaiting operator CP5 sign-off.

## The funded run (mainnet, cross-device, DKG-native)

| | |
|---|---|
| Deposit | `0xe3917be3…` · block 50090726 · 1.0 TRAC · verified on the seller's own RPC · hash consumed |
| Tab | `tab_1dfe28cb7d6ada35` · principal `0x8A87ea7c…` |
| ⛓ leg | `leg_e1552c0a…` · 42/29 tok · **258 µ** · recount exact · countersigned |
| ☁ leg | `leg_1a59f6bb…` · **240 µ** · gpt-5.4 via node-native OAuth · recount exact · countersigned |
| query leg | `leg_fb80afff…` · **5 µ** · countersigned |
| late-delivered ⛓ leg | `leg_27796e2b…` · 258 µ · see incident below · recounted + countersigned |
| Close | digest `sha256:694fb6ba…` · countersigned 4 / withheld 0 · buyer-verified signature |
| Conservation | **both seats independently: 1,000,000 = 761 + 999,239** |
| Settlement election | **REFUSED** (761 µ < 2,941,000 µ threshold) — remainder refundable |
| Cross-verification | **17/17** (`nsm-v3-evidence/phase5/cross-verification.json`) — incl. one check-script bug on the seller side, corrected and recorded |

**The two completions purchased (criterion 1 "usage", verbatim):**
- ⛓ *"Independent token recounting matters because it ensures the accuracy and integrity of the token counts, which is crucial for the reliability of natural language processing models."*
- ☁ *"Independent token recounting catches mistakes in token counts and helps verify cost, limits, and output integrity."*

### The incident that became the best evidence

The buyer's first ⛓ request was **served and billed, but the response KA
publish hit store backpressure (503) and was lost** — a billed-but-undelivered
leg. What followed is the protocol working under real failure:

1. The buyer **refused to countersign** a leg whose bytes he never received.
2. The seller suggested a withhold; the buyer **refused that too** — a withhold
   asserts a violation you can verify, and he had nothing to verify against.
   The seller withdrew the suggestion. *The veto refused to lie in both
   directions.*
3. Resolution: **deterministic late delivery.** The original request body was
   preserved in its lane KA; the seller regenerated the response (seed 42),
   verified it byte-equal to the leg's bound digest, and published it under the
   original correlation. The buyer recounted the real bytes — every check
   passed — and countersigned on merit. No new billing.
4. The retry pair produced **byte-identical output digests** — live proof of
   deterministic serving on mainnet (`determinismExhibit` in the receipt).
5. Fix shipped mid-run (`a283ebfa`): the executor now retries response
   publishes 6× with backoff. Cost of the incident: 258 µ duplicate billing
   for the buyer's retry, borne under signed-request semantics; v-next is
   idempotency keys for at-most-once billing across retries.

## Two architecture decisions taken mid-build (operator-driven)

- **DKG-native transport.** Cross-device messaging rides SWM gossip on a shared
  context graph, not Tailnet: the buyer publishes an EIP-191-signed request KA,
  the DKG replicates it, the seller replays it against its own loopback front and
  publishes the response KA. Each seat touches only its own node; the transaction
  transcript *is* knowledge assets on the DKG. Proven on the devnet (6/6, full
  purchase incl. recount+countersign+close, ~3–4s/round-trip). The wire contract
  is unchanged — the lane tunnels it.
- **☁ upstream = the operator's own Codex subscription over node-native OAuth.**
  Scoped to same-team buyers (recorded constraint: not for third-party resale).
  The DKG node runs the OAuth flow itself (PKCE, node as registered client);
  credentials live only in the node's secret store; metering bills locally
  verifiable o200k counts, never upstream usage (reasoning tokens are invisible
  in delivered bytes). Live completion verified.

---

## What v3 set out to build

A marketplace **module** on `OriginTrail/dkg` that turns a live DKG node into a
seller of metered AI: a local weights-pinned model (⛓) and a resold upstream API
(☁), each priced, published to the DKG as an offering, served with signed legs a
buyer recomputes locally, and settled on the same Iteration-1/2 spine — deployed
onto the **existing okf-mainnet node** without disturbing its lifetime ledger.

Two provenance classes run throughout:

| Badge | Class | Weights | Counts |
|---|---|---|---|
| ⛓ | `weights-pinned` | GGUF hashed, tokenizer bundle pinned | recountable from the pinned bundle |
| ☁ | `upstream-claimed` | a *claim* about the upstream, not a pin | recountable from the public bundle + template constants |

---

## Success criterion 1 — journeys respected

### Journey A — the seller (okf-mainnet)

| Step | Name | Evidence | State |
|---|---|---|---|
| A1 | Connect | ⛓ llama.cpp on loopback :8090; GGUF `sha256:e47ad95d…`; tokenizer bundle `sha256:2f21a92a…` (byte-identical vocab to the proven I2 Qwen2.5 bundle) | ✅ live |
| A2 | Price | signed quote on `GET /terms` → 402; 2µ/6µ per token, query 5µ+1µ/quad; `providerKeyId ed25519:73590f0c…` | ✅ live |
| A3 | Publish | both offering KAs resolve on the DKG (`…/nsm-offering-qwen25-14b` ⛓ + `…/nsm-offering-codex-cloud` ☁) with provenanceClass, pricing, tokenizer ref, endpoints | ✅ live |
| A4 | Expose | `/marketplace` served over the tailnet (HTTPS, scoped); `withdraw/settle/credit/release → 404` on the live node | ✅ live |
| A5 | Admit | deposit verified on the seller's own Base RPC (:8547, chainId 0x2105); tx hash consumed (409 on replay) — proven on devnet, same code path | ✅ proven (testnet) · ⏳ mainnet awaits a funded run |
| A6 | Serve & meter | signed legs: counts · price · delivered-bytes digest · tokenizer ref · provenanceClass · provider sig; ☁ upstream failure ⇒ no leg | ✅ proven (testnet) |
| A7 | Operate | node-UI Operate view (Offerings + threshold meter · Tabs & Usage · Access keys) over `/marketplace/operate/status` | ✅ built |
| A8 | Settle-or-refuse | threshold-gated, loopback-only election; below threshold ⇒ refused, balance refundable | ✅ proven (testnet): 936µ < 2,941,000µ refused |

¹ The KA's `apiBase` literal reads loopback (minted before tailnet exposure; the
node's WM lifecycle has no reopen/retract). The **authoritative** reachable
endpoint is the live *signed quote* (tailnet apiBase, verified) and the handover
runbook. See `nsm-v3-evidence/phase3/offering-ka-apibase-note.md`.

### Journey B — the buyer  ·  Journey C — the gateway consumer

Proven end-to-end on the devnet (two scratch nodes, real ERC-20 TRAC deposit on
the hardhat chain), **22/22 steps green** — this is the rehearsal that earned
CP2. Evidence: `nsm-v3-evidence/phase2/`.

| Step | Name | Evidence (devnet) |
|---|---|---|
| B3 | Verify quote | 13/13 invariants pass (`B3-quote-verification.json`) |
| B5 | Deposit & open | 1.0 TRAC transfer mined, `tab/open` verified on the seller's RPC, tx hash consumed → 409 |
| B6 | Mint key | buyer mints its own `nsm_k_…` (hashed at rest, shown once) |
| C1 | List | gateway lists both offerings badged ⛓/☁ |
| C2a | ⛓ inference | **genuine Qwen2.5-7B output**, recounted 40/22 tok = 212µTRAC, countersigned |
| C2b | ☁ inference | recounted against public bundle + constants, countersigned |
| C3 | Query | metered SPARQL, quads recounted, countersigned |
| C4 | Reconcile | per-key sub-ledgers sum to tab billed |
| B9 | Close & exit | signed close; conservation from **both seats independently**; threshold refusal |

**Example completions purchased (devnet, verbatim):**
- ⛓ *"A knowledge graph organizes and represents structured and interconnected data to provide a comprehensive understanding of entities and their relationships."*
- ☁ *"A knowledge graph organizes entities and their relationships as a queryable graph."*

> On **mainnet**, the two example completions purchased **by Hermes** (one ⛓, one
> ☁) are the criterion-1 "usage" evidence and are **pending his funded run**
> (CP4). The mechanics are proven; the cross-device money leg is not yet run.

---

## Success criterion 2 — carried invariants on record

| Invariant | Evidence | State |
|---|---|---|
| **okf-mainnet state continuity** | pre/post-upgrade conservation projections **byte-identical**: `sha256:99488cff…` across the build swap AND a second restart; `5,000,000 == 5,000,000` throughout | ✅ **proven live** |
| Conservation, both seats | devnet: seller journal projection + buyer independent recompute agree; `conservation-{seller,buyer}.json` | ✅ proven (testnet) |
| WITHHOLD demos, correct codes | three tamper drills over the wire → `E_BYTES_DIGEST`, `E_RECOUNT_MISMATCH` (query), `E_RECOUNT_MISMATCH` (☁ template drift); plus 39/39 fixture set incl. all 5 codes | ✅ proven |
| Threshold refusal | `threshold-election.json`: 936µ unsettled < 2,941,000µ threshold → refused | ✅ proven (testnet) |
| 404 probes | live okf-mainnet: withdraw/settle/credit/release → 404; `phase3/404-probes.txt` | ✅ **proven live** |
| Secret redaction | fixture + **live check on okf-mainnet**: Codex access token absent from logs/legs/lane-store/status endpoint; secret store 0600 | ✅ **proven live** |
| Ledger compat | ported v3 ledger parses the **live okf-mainnet journal** on a copy (28 records, 7 kinds, 0 errors) — no migration needed | ✅ proven |

---

## The build

One workspace package `@origintrail-official/marketplace`, mounted as a **route
plugin** (`marketplace.enabled=false` by default → routes absent/404, verified).
The only core change is one byte-compatible file — `dist/auth.js` gains a
`/marketplace` public mount-point (the counterparty holds no node token; its auth
is the plugin's EIP-191 signed-request layer). Import boundary lint-enforced:
the package imports only node builtins, ethers, and the host's public
`plugin-api`.

- `core/` — seven Iteration-2 metering modules ported **byte-identical**
- `seller/` — Appendix-A front, EIP-191 auth (method+path+body+tab+nonce, durable nonce burn), llama.cpp + OpenAI connectors, offering publisher
- `buyer/` — quote verifier, byte-level BPE recount (HF + tiktoken), the five-code leg veto, EIP-191 client
- `gateway/` — `nsm_k_…` keys (scoped, hashed, shown once), in-path recount-before-countersign, per-key sub-ledgers
- `node-ui/` — Marketplace discovery + Operate views

Branch `prototype/nsm-marketplace-v3` @ `15042106` on `OriginTrail/dkg`.
Fixtures: **39/39**. Devnet two-seat E2E: **22/22**.

---

## What is NOT achieved, stated plainly

- ~~Hermes's cross-device funded run~~ — **achieved** (see "The funded run").
- **A reverse-direction / third-party ☁ sale.** The ☁ offering is live and its
  upstream verified, but scoped to same-team buyers by design; it is not offered
  to third parties (subscription-terms boundary, stated).
- **An economic netted settlement.** The threshold refusal is correct behavior;
  no mainnet payout has occurred (and on devnet the earned total was far below
  threshold by design).
- **Odysseus as a live co-located consumer.** Wired in principle (gateway +
  implicit key), but a real on-device purchase was superseded in priority by
  the cross-device funded run. The gateway key path is devnet-proven (22/22).
- **Buyer-side gateway on a stock runtime.** The buyer ran stock 10.0.13 (the
  branch daemon is 10.0.12-based and cannot open his schema-3 home), where the
  auth layer lacks the `/marketplace` mount-point — his `nsm_k_` consumer
  routes 401 there. His purchases ran through the LaneBuyerClient instead
  (by design). v-next: rebase the branch onto the current release.
- **The offering-KA apiBase in-place update.** Not supported by the node's WM
  lifecycle; mitigated by the authoritative signed quote (note ¹).

---

*Compiled live from okf-mainnet (pin/quote `ed25519:73590f0c…`, provider
`0x633E5a7C…`), the devnet two-seat run, and the branch build. No capture is
reconstructed. Pending items are marked, not hidden.*
