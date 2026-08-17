# UI-COPY.md — the only source of interface text

Claude Code renders strings **from this table by key**. A string that isn't
here doesn't ship: propose it as a table addition first (PR to this file),
then use it. Tone: plain, calm, specific. No exclamation marks. No blame-y
error voice. Technical exactness lives one reveal deeper, never first,
never hidden.

## Number display rules

- Per-1M-token prices (catalog, model page): `2 µ / 6 µ per token` is banned in
  primary UI → show `~$X.XX / 1M tokens` with `N µTRAC / 1M` as the secondary
  line. FX tooltip: `numbers.fx`.
- Per-message cost chips: compact µ (`258 µ`); tooltip shows exact µTRAC + USD.
- Balances: TRAC to 4 dp + USD subtext. Exact µTRAC in the detail drawer.
- Digests/keys/addresses: `--font-mono`, first 8 chars + `…`, click-to-copy.

## Verification lifecycle (the chips)

| key | string |
|---|---|
| state.checking | Checking this bill… |
| state.verified | Verified — we re-counted it ourselves |
| state.verified.short | Verified ✓ |
| state.pending | Waiting for delivery — nothing is owed until it arrives |
| state.pending.short | Waiting for delivery |
| state.pending.deadline | Delivery due in {t} — the bill cancels automatically if it doesn't arrive |
| state.voided | Never delivered — bill canceled automatically |
| state.blocked.short | Payment blocked |
| state.rerouted | Rerouted to {provider} — the failed try cost nothing |

## Withhold reasons (plain first; code shown in the drawer)

| key | string | code in drawer |
|---|---|---|
| withhold.bytes | What we received doesn't match what was billed — payment blocked | E_BYTES_DIGEST |
| withhold.recount | The token count doesn't add up — payment blocked | E_RECOUNT_MISMATCH |
| withhold.tokenizer | Billed with a different tokenizer than promised — payment blocked | E_TOKENIZER_DRIFT |
| withhold.overbill | Charged above the agreed price — payment blocked | E_OVERBILL |
| withhold.signature | The bill isn't properly signed — payment blocked | E_LEG_SIGNATURE |
| withhold.explain | Blocking payment is the system working: charges are only paid after this node re-checks them |

## Receipt drawer (labels for technical rows)

| key | string |
|---|---|
| receipt.title | Receipt |
| receipt.counts | Tokens — claimed {a}/{b} · our count {a}/{b} |
| receipt.price | Price applied |
| receipt.bytes | Delivered content fingerprint |
| receipt.sig | Seller signature |
| receipt.countersign | Our agreement to pay |
| receipt.close | Included in close {digest} |
| receipt.chain | View on Basescan |

## Onboarding

| key | string |
|---|---|
| onboard.title | Two steps to your first verified completion |
| onboard.fund.title | Fund |
| onboard.fund.body | Set one budget. This node opens and manages provider tabs for you. |
| onboard.fund.cta | Set budget |
| onboard.fund.empty | This node's wallet is empty. Send TRAC (and a little ETH for fees on Base) to {address}. |
| onboard.key.title | Get your key |
| onboard.key.body | Works with anything that speaks the OpenAI API — paste the two lines below. |
| onboard.key.once | Shown once. Store it now. |
| onboard.kpi | First verified completion in {mm:ss} |

## Catalog & model page

| key | string |
|---|---|
| catalog.providers | {n} providers |
| catalog.provider.one | 1 provider |
| catalog.volume | {n} tokens settled |
| catalog.volume.tip | Counted only from countersigned, settled usage — not self-reported traffic |
| prov.pinned | Weights verified |
| prov.pinned.tip | The exact model file is fingerprinted; every bill is re-counted against its own tokenizer |
| prov.claimed | Provider-reported model |
| prov.claimed.tip | Bills are fully re-checked; the model's identity is the provider's claim |
| model.rep | {a} verified · {d} disputed |
| model.rep.tip | Disputes prove the auditing is real. A long history with zero disputes is either flawless or unaudited — and you can't tell which. |
| model.uptime.ok | Responding |
| model.uptime.down | Unreachable ({t} ago) |
| model.buy | Use this model |
| model.try | Try in playground |

## Playground

| key | string |
|---|---|
| play.compare | Compare side by side |
| play.cost.tip | {exactMicro} µTRAC · ~${usd} — tap for the full receipt |
| play.stream.note | Verifying as it streams… final check on completion |

## Treasury & keys

| key | string |
|---|---|
| treasury.balance | Available to spend |
| treasury.balance.tip | Wallet plus everything refundable from open tabs — it's all still yours until work is delivered and verified |
| treasury.conservation | Every µ accounted for: {lhs} = {billed} + {refundable} |
| treasury.topup | Top up |
| treasury.refund | Take money back |
| treasury.close | Close tab |
| key.budget | {spent} of {cap} used |
| key.exhausted | This key hit its budget cap. Raise the cap or top up to continue. |
| key.revoked | Revoked — stops at the next call |
| key.sum.ok | This key's charges add up ✓ |

## Seller / Operate

| key | string |
|---|---|
| gauge.threshold.low | Not yet worth settling — network fees would exceed earnings |
| gauge.threshold.mid | Accumulating toward payout |
| gauge.threshold.ready | Ready to settle |
| gauge.threshold.tip | Earned {earned} of the {threshold} needed for an economic payout |
| operate.margin.reasoning | Upstream tokens you pay for but can't bill (reasoning): {pct} |
| operate.pending.aging | {n} bills waiting on delivery — oldest due in {t} |
| listing.preview | Exactly how buyers will see this listing |

## Errors (normalized, agent- and human-facing)

| key | string |
|---|---|
| err.401 | This key was revoked |
| err.402.budget | Budget cap reached |
| err.402.unfunded | No funded tab covers this model — fund it in Treasury |
| err.429 | Slow down — rate limit reached |
| err.5xx | The provider had a problem. Nothing was charged. |
| err.offline | Can't reach the provider right now. Nothing was charged. |

## Empty states

| key | string |
|---|---|
| empty.catalog | No offerings found on the graphs this node can see |
| empty.tabs | No open tabs — fund a model from the catalog to start |
| empty.keys | No keys yet — mint one to let an agent spend here |
| empty.activity | Nothing spent yet |

## Proposed additions — v3.5 Phase 2 M-gate (per the header rule: proposed here first, used only after this lands)

Rationale: strings the surface specs require structurally (controls, confirm
flows, diagnostics) that had no key yet. Same tone rules.

| key | string |
|---|---|
| ctl.copy | Copy |
| ctl.retry | Retry |
| ctl.send | Send |
| ctl.cancel | Cancel |
| ctl.back | Back |
| ctl.done | Done |
| ctl.clear-filters | Clear filters |
| onboard.fund.watch | Balance refreshes automatically once funds arrive. |
| chain.confirming | Confirming on Base… |
| chain.confirmations | {n} of {m} confirmations |
| catalog.search | Search models… |
| catalog.metered | This view cost {n} µ · why? |
| catalog.filter.zero | No models match these filters |
| catalog.asof | as of {t} — refreshing… |
| model.quote.unverifiable | Terms couldn't be verified |
| model.telemetry.none | no data yet |
| model.quote.provenance | Price and endpoint on every row come from a live signed quote fetched just now — never from the listing itself. |
| play.composer | Message… |
| play.lane.waiting | Waiting for the response to arrive over the lane… |
| play.open.treasury | Open Treasury |
| receipt.reason | Reason |
| receipt.claimed | Claimed |
| receipt.recount | Our recount |
| treasury.ring.parts | wallet {a} + refundable {b} |
| treasury.confirm.title | Confirm this on-chain transfer |
| treasury.confirm.amount | Amount |
| treasury.confirm.from | From |
| treasury.confirm.to | To |
| treasury.confirm.cta | Confirm transfer |
| treasury.refund.pending | Refund in flight |
| treasury.refund.done | Refunded ✓ |
| treasury.diag | {n} µ unaccounted — open the ledger diagnostic |
| key.mint | + Mint key |
| key.mint.title | Mint a key |
| key.raise | Raise cap |
| key.revoke | Revoke |
| key.expiry | expires in {n}d |
| key.sum.gloss | Σ per-key charges equals the tab's billed total |
| key.sum.broken | This key's charges don't add up — Σ {sum} µ ≠ tab billed {billed} µ |
| operate.pending.aging.one | 1 bill waiting on delivery — oldest due in {t} |
| operate.earnings.title | Earnings → payout |
| operate.gauge.sub | to payout |
| operate.legs.title | Legs |
| operate.offerings.title | Offerings |
| operate.offering.live | live |
| operate.offering.paused | paused |
| operate.offering.edit | Edit |
| operate.offering.pause | Pause |
| operate.offering.resume | Resume |
| operate.settle | Settle |
| operate.settle.local | Settlement runs from this node only — there is no public settle route. |
| operate.withhold.mix | Blocked payments by reason |
| operate.margin.line | upstream est {a} · billed {b} |
| operate.upstream.down | upstream unreachable — serving halted; failed calls create no bills |
| wizard.connect | Connect |
| wizard.price | Price |
| wizard.preview | Preview |
| wizard.publish | Publish |
