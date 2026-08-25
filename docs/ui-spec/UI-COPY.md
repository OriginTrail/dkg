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

## Additions — landed (operator-approved at the M-gate, 2026-08-18)

Strings the surface specs require structurally (controls, confirm flows,
diagnostics) that had no key yet. Same tone rules.

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
| onboard.fund.label | Budget |
| key.name.label | Name |
| key.cap.label | budget cap |
| onboard.fund.pending | Budget {amount} TRAC (~{usd}) will open your first tab when confirmed. |
| onboard.disabled | Marketplace is switched off on this node. Enable it in the node's marketplace config and restart. |
| onboard.unconfigured | No buyer seat configured yet — this node needs a seller address and wallet before it can buy. |
| chain.confirming | Confirming on Base… |
| chain.confirmations | {n} of {m} confirmations |
| catalog.search | Search models… |
| catalog.metered | This view cost {n} µ · why? |
| catalog.filter.zero | No models match these filters |
| catalog.asof | as of {t} — refreshing… |
| catalog.free | Browsing is free — this page reads only your own node's subscribed graphs |
| nav.models | Models |
| nav.playground | Playground |
| nav.treasury | Treasury |
| nav.access | Access |
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

---

# P5 additions — the subscription rail (surfaces 08–11 + amendments)

P4 keys above remain valid where their surfaces survive. The per-message
verification chips (`state.*`) are retired from primary surfaces in P5 —
verification lives at the statement line and spot-check flags. The withhold
table remains, relabeled for the dispute drawer.

## Subscribe → Key onboarding (amends §Onboarding)

| key | string |
|---|---|
| onboard.p5.title | Two steps to your first metered completion |
| onboard.sub.title | Subscribe |
| onboard.sub.body | Pick a plan or compose your own. One payment per provider per period — then everything is included up to your ceilings. |
| onboard.sub.cta | Choose a plan |
| onboard.sub.template | Starter plan — {models} plus {units} query units, {price}/period |
| onboard.pay.gate | Confirm this period's payment |
| onboard.pay.line | {amount} TRAC to {seller} — covers {scope} until {resetDate} |
| onboard.pay.norefund | Payments are final. Unused allowance expires at period end — like any subscription. |

## Plan composer

| key | string |
|---|---|
| composer.title | Compose your plan |
| composer.budget | Period budget |
| composer.period | Period |
| composer.period.note | Prices are frozen for the period. Changes you make take effect at the next period. |
| composer.seller.auto | Provider chosen automatically at your price cap |
| composer.seller.pinned | Pinned to {seller} |
| composer.shared | Shared allowance (recommended) |
| composer.shared.preview | ≈ up to {tokens} {model} tokens or {units} query units — any mix |
| composer.scoped | Scoped allowance |
| composer.scoped.preview | At least {floor} tokens at your price cap — more if routed cheaper |
| composer.payments | This plan pays {n} providers: {lines} |
| composer.guarantee | Guaranteed at your price cap. Cheaper routing gives you more, never less. |

## Plans & meters (replaces §Treasury; the Claude usage idiom)

| key | string |
|---|---|
| meter.plan.headline | Plan: {pct}% used |
| meter.plan.resets | Resets in {n} days |
| meter.plan.resets.hours | Resets in {n} hours |
| meter.line.model | {model}: {used} of {ceiling} tokens |
| meter.line.query | {offering}: {used} of {ceiling} query units |
| meter.line.shared | {seller} shared: {usedValue} of {ceilingValue} — any mix of {scope} |
| meter.warn.approaching | {pct}% used — approaching your ceiling |
| meter.hit.title | You've reached this ceiling |
| meter.hit.body | Three ways forward — nothing is lost, your plan resets in {t}. |
| meter.hit.wait | Wait for reset ({t}) |
| meter.hit.upgrade | Upgrade next period |
| meter.hit.topup | Top up now |
| meter.topup.gate | Confirm top-up: {amount} TRAC to {seller} — extends {scope} this period |
| meter.expired.journal | Expired at period end: {value} — value recognized, not returned |
| meter.expired.tip | Subscriptions don't refund. What you don't use funds the network you're part of. |

## Statement line

| key | string |
|---|---|
| stmt.line.ok | This period: our count {ours} · provider count {theirs} ✓ |
| stmt.line.wait | Period closes in {t} — counts reconcile then |
| stmt.line.disputed | Counts disagree: ours {ours} · theirs {theirs} — dispute opened |
| stmt.resolved | Resolved: {resolution} — recorded in the statement |
| stmt.ka | Statement published — view the Knowledge Asset |
| stmt.spot.ok | Spot-checks this period: {n} sampled, all matched |
| stmt.spot.flag | A spot-check didn't match — this pair goes to full recount at close |
| stmt.itemized | Itemized: {lines} |

## Node storefront

| key | string |
|---|---|
| store.title | Everything {node} serves |
| store.ask.current | Current ask |
| store.ask.next | Next cycle: {ask} |
| store.volume | {n} statement-verified units this epoch |
| store.uptime | {pct}% responding, last {window} |
| store.subscribe.all | Subscribe to this node's shelf |
| store.query.covers | Answers queries over: {cgs} |
| store.query.schedule | Priced by the published cost schedule — both sides can recompute every unit |

## Playground (amendments)

| key | string |
|---|---|
| play.servedby | via {seller} {prov} |
| play.remaining | {model} · {pct}% left |
| play.fork.inline | This model's ceiling is reached mid-conversation. Your words are safe. |
| play.query.cost | {units} query units — {basis} |

## Seller Operate v5

| key | string |
|---|---|
| op.ask.editor | Your ask — takes effect next cycle |
| op.subscribers | {n} active subscriptions this period |
| op.stmt.queue | Statements awaiting your signature: {n} |
| op.revenue.wallet | Subscription revenue — separate from the operations wallet |
| op.revenue.note | Buyer payments land here and only here. The ops wallet never holds customer funds. |
| op.calibration | Export calibration data |

## 402 fork (API-level, rendered by clients)

| key | string |
|---|---|
| fork.402.title | No active ceiling for {model} |
| fork.402.body | Subscribe, upgrade, or top up — this key's plan doesn't cover this model right now. |

---

# CP-R revision (D1–D12) — supersedes conflicting P5 keys above

**Banned in the primary layer** (D6): metered completion · cost-schedule
priced · statement-verified · epoch · provenance · scoped · price cap ·
unit basis. These words may appear only one reveal deeper (drawers, tooltips).

| key | string |
|---|---|
| onboard.p5.title | Three steps to your first answer |
| onboard.consent.title | One confirmation — your plan's payments |
| onboard.consent.total | {n} transfers · {trac} TRAC total (~${usd}) |
| onboard.consent.progress | Transfer {i} of {n} confirmed… |
| onboard.customize | Customize → |
| chip.left | {pct}% left |
| chip.tap | Tap for exact amounts, reset date and pool |
| composer.advanced | Advanced |
| composer.pool.one | One pool (recommended) |
| composer.pool.separate | Separate budgets |
| composer.maxprice | Max price |
| composer.route.note | Your node picks the cheapest included provider automatically. |
| meter.pool.line | {seller} pool — ${used} of ${ceiling} · any mix of {n} offerings |
| meter.separate.label | (separate budget) |
| meter.floor.note | At least {floor} tokens at your max price — routed cheaper {n}×, +{extra} extra |
| meter.legend | Mostly {top} ({pct}%) · {rest} |
| meter.pace.warn | At this pace: runs out ~{d} days before reset |
| meter.pace.ok | On track to expiry |
| meter.expired.tip | Unused allowance expires at period end — like any subscription. |
| fork.topup | Top up |
| fork.line | or wait — resets in {t} · or switch to {alt}, {pct}% left |
| play.pool | Pool: {pct}% left |
| activity.title | Recent activity |
| activity.filter | Key: {key} |
| store.volume.plain | {n} units served · counted by both sides this period |
| catalog.query.plain | priced per query |
| access.cap | {pct}% of cap |
| access.mix | {mix} |
| access.revoke | Revoke — stops at the next call |

Removed (D7): `meter.expired.tip` former text ("What you don't use funds the
network…") — false in P5; unused value accrues to the seller until the RFC.

---

# Part-0 revision (separate meters) — supersedes pool keys above

The shared value-denominated pool is removed from P5. Superseded keys:
`meter.pool.line` · `meter.line.shared` · `composer.pool.one` ·
`composer.pool.separate` · `meter.legend` · `play.pool` · `composer.shared*`
· `composer.scoped*` · `meter.separate.label`. Replacements:

| key | string |
|---|---|
| meter.summary | Plan overall: {pct}% of this period's value used |
| meter.summary.note | A readout, not a limit — each meter below is its own ceiling. |
| meter.offering.line | {offering} — {pct}% used · Resets in {t} |
| meter.offering.tap | {used} of {ceiling} {unit} · ${usd} spent |
| composer.preview.offering | ≈ {ceiling} {unit} per period |

---

# Re-shoot delta + keying convention (CP-R riders, 2026-08-25)

**Convention (binding, mockups AND integrated components):** every
user-facing string node carries `data-copy="<key>"`. Content-derived text
(model names, node names, numbers) uses `data-copy="_data"`. Node-UI shell
chrome is outside marketplace copy scope. Probe:
`mockups/p5/copy-probe.mjs` — a scoped element without a key fails the run.

Superseded by the consolidated delta: `fork.line` (wait option removed) ·
`meter.hit.wait` · `composer.route.note` (no runtime routing exists).

| key | string |
|---|---|
| gate.confirm | Confirm |
| gate.cancel | Cancel |
| onboard.sub.cta | Choose this plan |
| composer.review | Review payments → |
| composer.provider.note | One provider per offering, chosen here. The cheapest is pre-selected; compare and switch on the model page — changes take effect at the next period. |
| fork.line.v2 | or switch to {alt}, {pct}% left — every other meter still works |
| meter.newperiod | Start a new period |
| meter.newperiod.note | Nothing renews by itself — a new period begins only with a new confirmed payment. |
| meter.period.ended | Period ended |
| model.provider.yours | your provider ✓ |
| model.provider.switch | Switch next period |
| model.provider.note | One provider per offering, chosen when you subscribe — this page is where you compare. Switching takes effect at the next period. If your provider fails, the call charges nothing and says so. |
| stmt.freshness | Counts agree ✓ · checked {t} ago |
| catalog.add | Add to plan |
| access.title | Access |
| access.mint | + Mint key |
| access.revoke.btn | Revoke |
| op.wallets | Wallets |
| op.stmt.cosign | Review & co-sign |
