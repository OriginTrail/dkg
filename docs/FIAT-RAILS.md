# FIAT-RAILS.md — charging buyers in fiat while settlement stays TRAC

*NSM v3.5 · Phase 6 deliverable · **design, not production**. Stripe is the
worked example; any PSP with hosted checkout + webhooks + refund API fits the
same seams. Everything here is gated: no live keys, no real card data, PCI
stays the PSP's problem. The dual-currency display (USD primary, µTRAC one
reveal deeper) shipped with Phase 2 and is the first visible step of this
design.*

---

## 1. The shape of the problem

The marketplace's unit of account is µTRAC: tabs are funded by ERC-20 TRAC
deposits, legs are billed in µTRAC, closes and refunds settle in TRAC. Buyers
who think in dollars should not need to acquire TRAC, hold a wallet, or price
gas to buy a verified completion. The protocol beneath must not change: the
seller still sees an on-chain deposit, still bills signed legs, still refuses
everything the wire contract refuses.

So fiat enters at exactly one seam: **someone who already holds TRAC funds the
tab on the payer's behalf, and collects fiat for it.**

## 2. The fiat-gateway role

A **fiat gateway** is any node that:

1. holds a TRAC float (its own working capital, not customer funds),
2. accepts a PSP payment (Stripe Checkout) denominated in fiat,
3. on payment confirmation, executes the normal buyer-side funding rail —
   verify the seller's signed quote, ERC-20 deposit, `/tab/open` — **on the
   payer's behalf**, and
4. issues the payer their gateway credentials (`nsm_k_…`) against that tab.

Any eligible node can occupy the role: a dedicated operator, a marketplace
front-end, or **the seller's own node** (selling its own inventory for fiat —
float risk collapses to inventory risk). The role is an *operational* posture,
not a protocol change: the wire contract has no fiat concept anywhere.

The buyer-of-record on-chain is the gateway's wallet. The payer's claim on
the tab is the key the gateway mints — the same budget/scope/revocation
machinery Access already renders (per-key sub-ledgers are what make "your
$20 bought this much" auditable).

## 3. Sequence — checkout → funded tab

```
payer            gateway node               PSP (Stripe)        seller node
  │ choose model,   │                           │                   │
  │ amount ($)      │                           │                   │
  ├────────────────►│ create Checkout Session   │                   │
  │                 ├──────────────────────────►│                   │
  │   hosted checkout page (PSP-hosted; card data never touches us) │
  │◄────────────────┼───────────────────────────┤                   │
  │ pay             │                           │                   │
  │                 │   webhook: checkout.session.completed          │
  │                 │◄──────────────────────────┤                   │
  │                 │ 1. freeze FX: fiat→µTRAC at the quoted rate    │
  │                 │ 2. verify seller's signed quote (unverifiable  │
  │                 │    ≠ pass — abort → auto-refund)               │
  │                 │ 3. ERC-20 TRAC transfer (float → seller)      │
  │                 ├──────────────────────────────────────────────►│
  │                 │ 4. POST /tab/open {txHash}                    │
  │                 ├──────────────────────────────────────────────►│
  │                 │        tab {tabId}                            │
  │                 │◄──────────────────────────────────────────────┤
  │                 │ 5. mint nsm_k_ scoped to the paid budget      │
  │ key + snippet   │                           │                   │
  │◄────────────────┤                           │                   │
```

Idempotency: the webhook handler keys on the Checkout Session id exactly the
way the serving path keys on `x-nsm-idempotency` — at-most-once funding per
payment, journaled before the transfer is broadcast (crash between 3 and 4
recovers by replaying `/tab/open` with the journaled txHash; the seller's
tx-hash-consumed rule makes the replay safe).

## 4. The FX seam

- **Reference rate**: frozen per payment at checkout-session creation, shown
  to the payer before they pay ("$10.00 ≈ 35.7 TRAC at $0.28/TRAC · rate
  locked for 15 minutes"). The session expires with the rate.
- **Who holds FX risk**: the gateway, knowingly — it is a float operator; the
  spread it charges (§6) is where that risk is priced. Neither the payer
  (fixed fiat price) nor the seller (fixed µTRAC billing) carries it.
- The frozen rate, its source, and its timestamp are journaled with the
  funding record — the payer's receipt can show exactly what was locked, and
  the same record backs any later refund computation.

## 5. Refunds — two ledgers, one truth

The on-chain refund path is unchanged: close the tab, the seller's refund
duty covers the refundable remainder to the **gateway's** wallet (the
on-chain buyer). The gateway then maps it back to fiat:

| case | on-chain | PSP side |
|---|---|---|
| unused budget at close | refundable µTRAC → gateway wallet | partial Stripe refund at the **frozen** rate (not spot) |
| seller unreachable / quote unverifiable before deposit | nothing moved | full refund (or void) of the session |
| withheld legs (buyer veto fired) | withheld amounts never left the tab; they return in the refundable remainder | folded into the same partial refund |
| chargeback after TRAC settled | **irreversible on-chain vs reversible fiat — the gateway's core exposure** | gateway eats it; mitigations: Stripe Radar, per-payer limits, delay high-value key activation until dispute window shortens |

The asymmetry in the last row is structural, not fixable by design: fiat
rails are reversible, settlement is not. It is priced (spread), bounded
(limits), and journaled (every chargeback maps to a specific tab whose legs
are signed and countersigned — the strongest dispute-evidence a merchant can
file).

## 6. Custody and float accounting

- The float is the gateway's **own** TRAC. Payer money exists only inside the
  PSP until payout; the gateway never holds customer fiat balances (this is
  the load-bearing distinction for §8).
- Float conservation is the same discipline the UI already renders:
  `float = wallet + Σ open-tab refundable (gateway-funded tabs)`, checked
  continuously; a break is surfaced, never hidden — the Treasury surface's
  conservation line applies verbatim to the gateway's own view.
- Pricing: `fiat_charged = µTRAC_budget × frozen_rate × (1 + spread)`; the
  spread covers FX risk, chargeback reserve, PSP fees, gas.

## 7. Failure modes

| failure | consequence | handling |
|---|---|---|
| webhook delivered, transfer fails (gas, RPC) | paid but unfunded | journaled retry; if terminal → automatic full refund; payer never left holding nothing silently |
| transfer sent, `/tab/open` refused (E_TX_* ) | float moved, no tab | retry against the confirmation rule; terminal refusal is a seller-side incident — the deposit is on-chain evidence for recovery |
| PSP payout freeze / account closure | fiat side stalls | float keeps serving open tabs (protocol unaffected); new sessions pause |
| gateway insolvency mid-tab | keys stop refreshing budget | tabs already funded keep working; on-chain refundable belongs to the gateway's estate — payers' exposure is bounded to unspent key budget, which is why per-payment budgets should stay small |
| rate source outage | cannot freeze new rates | new sessions pause; open sessions honor their locked rate |

## 8. Compliance flag — named for legal review, not designed around

Operating a fiat gateway plausibly touches **money transmission** (fiat in,
value out to third parties), **KYC/AML obligations**, and PSP terms governing
crypto-adjacent merchants. Jurisdiction decides; this document deliberately
does none of that analysis. Before any production deployment:

- legal review of money-transmitter status per operating jurisdiction —
  including whether "gateway funds its own tab and licenses access" (the §2
  key model) changes the analysis vs "gateway transmits value";
- PSP approval for the merchant category (Stripe's crypto policies apply
  even when the customer never touches crypto);
- KYC thresholds and sanctions screening, if required, at the PSP tier first.

**Nothing in this repo implements any of the above.** The design keeps the
surface small precisely so the licensed entity, if one is ever needed, wraps
the gateway role without touching the protocol.

## 9. What ships now vs later

| step | status |
|---|---|
| dual-currency display (USD primary, µTRAC one reveal deeper, FX tooltip) | **shipped** (Phase 2, all surfaces) |
| this design | **this document** |
| CP3 spike (optional, operator-gated): Stripe **sandbox** checkout → devnet tab funding, end to end | not built unless CP3 grants it |
| production Stripe, live fiat, KYC | **out of scope** (rule 4) |
