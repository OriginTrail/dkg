# Prompt for Claude Code — NSM Prototype 5: the subscription rail

You are Claude Code operating on the operator's device. Prototype 5 turns the product brief into running code: **the tab rail (deposit → spend → refund) is retired, and the subscription rail replaces it** — period payments, per-model token ceilings, no refunds, both-sides metering, one signed statement per pair per period. This is the prototype whose data calibrates the RFC, so telemetry is a first-class deliverable, not an afterthought.

**Specs of record:** `docs/nsm-product-brief-and-protocol-roadmap.md` (Part 1 is the build spec; Part 2 is out of scope), `docs/ui-spec/` (extend it, never bypass it), and the Prototype 4 evidence report for current system state. If any of these are missing from the repo, stop at CP0 and ask — never proceed on memory of them.

---

## Non-negotiable rules

1. **Real money gates.** The only mainnet transactions in this prototype are subscription payments — one per seller per period — and each requires an explicit human "yes" naming amount, from, to. Rehearse everything on devnet first.
2. **The no-refund doctrine is absolute.** Never build a refund path, not even a hidden debug one. Unused allowance at period end is journaled as `expired` — value recognized, never returned. If a flow seems to need a refund, the design is wrong; stop and ask.
3. **Chain-footprint audit.** At all times: on-chain transactions per buyer per period = number of subscribed sellers. Zero per message, zero per statement. The evidence report proves this from Basescan.
4. **Secrets** — carried unchanged: keys in gitignored files only; never echoed, logged, committed, or posted to Buzz; Stripe strictly test mode.
5. **Honesty conventions** — carried unchanged: real captures only, mockups labeled as mockups, statuses re-stamped when they change, not-achieved stated plainly.
6. **Existing-node care (rule 7)** — applies to `okf-mainnet`, the MacBook node, and Hermes's node: backup, compat check on a copy, rollback pin, human-gated restarts. The Prototype-4 ledger history must survive the migration untouched (read-only archive; the new rail writes its own journal).
7. **Buzz is mandatory (rule 8)** — runbook, SHA parity echo, statements coordination, and receipts in **#neurosymbolic-ai**; any substitution announced in-channel first and recorded.
8. **Ask, then fill** — one question, best-guess default attached.

---

## The scoping decision, stated so no one discovers it later

The brief's network-pooled emission (payments into protocol-held pools, epoch distribution, Query/Inference Factor) is **Part 2 / RFC territory and is not built here.** Prototype 5 implements the honest app-layer version: **a plan is composed of per-seller subscriptions under the hood.** The buyer pays each subscribed seller once per period; ceilings are per (model, seller); the plan UI aggregates them and the router picks among subscribed sellers under the buyer's price cap. Consequences to state plainly in the report: unused-allowance value accrues to sellers (not the network) until the RFC lands, and custody is seller-held — mitigated by paying into each seller node's **dedicated subscription-revenue wallet** (never the ops wallet; the Prototype-3 commingling defect must be structurally unrepeatable), by short periods, and by the statement evidence trail. Bounded risk, named, accepted for the prototype.

---

## Carried from Prototype 4 — now explicit acceptance criteria

The OpenRouter-shaped experience survives the settlement swap unchanged, and the report must prove it:

- **One API, one key.** Agents keep a single OpenAI-compatible endpoint and one minted `nsm_k_` key no matter how many sellers the plan spans. `GET /v1/models` lists **every model with an active ceiling across all subscribed sellers** — the multi-model menu *is* the plan, rendered as a model list.
- **One provider per offering, chosen at plan time.** Each model and each knowledge service has exactly one chosen provider at any moment; comparison and selection happen on the model page and in the composer (per-cycle asks keep the comparison stable), and a request simply goes to the chosen provider. Switching providers takes effect at the next cycle. **No silent fallback:** a provider failure charges nothing, says so plainly, and any switch is the buyer's deliberate act. A model with no active ceiling returns the 402 fork — never a dead-end error.
- **The meter is the product.** Consumption decrements the per-model ceiling; the meter ("1.2M of 5M · expires in 12 d") is the primary surface. **Monthly is the product-default period**; weekly is config; compressed periods exist only as a test device, plus the 1-day mainnet run. Meter anatomy follows **Claude's own usage idiom** — a progress bar per scope, "X% used", a plain countdown, an approaching-limit warning state, and a limit-reached message that presents options instead of a wall — with one deliberate divergence: **we say "Expires", never "Resets"**. Claude can say Resets because a stored card renews silently; P5 holds no payment authorization, so every new period is a new consented payment, and the meter must not promise otherwise.
- **Query and inference ride one mechanism.** A plan holds **query ceilings (unit: query units)** beside model ceilings (unit: tokens); the same minted key calls `/v1/chat/completions` and `/v1/query`. A query offering names the curated Context Graph(s) it covers and prices in query units computed from a pinned, content-addressed **Query Cost Schedule KA**: base + static complexity of the parsed query (triple patterns, joins, property paths, OPTIONAL/UNION, filters, aggregations, missing-LIMIT surcharge) + per-returned-result weight. Every term is computable by both sides from bytes both hold — execution-dependent cost (scanned work) is never billed; sellers cover its residual via the base term, their per-unit ask, and execution guards. Meters, statements, and the calibration export itemize both units.
- **Separate meters by design.** Each selected model carries its own token ceiling; each knowledge service its own query-unit ceiling; consumption never blends across offerings. One plan and one payment set cover them all; any plan-level "overall" figure is a **display aggregate only, never a ceiling**. Hitting one meter leaves the others usable. (A flexible cross-offering credit is a possible post-RFC feature under network pooling — a seam, not in P5.)
- **Funding sources are a seam, not a fork.** TRAC period payments are the only funding source built in P5 — but the Plan object carries a `fundingSource` field from day one so that Conviction-Account allowances (RFC-gated) and fiat entitlements (CP3 spike only) plug in later without schema surgery.

## Human checkpoints

- **CP0 · State & seats.** Confirm: (a) the branch/commit Prototype 4 finished on — P5 branches from it as `prototype/nsm-v5-subscriptions`; (b) node inventory (okf-mainnet, MacBook node, Hermes's node) and their runtime versions; (c) the three spec docs are in the repo; (d) **seat plan** — default: okf-mainnet sells **four offerings — Qwen2.5 14B Instruct ⛓ · Qwen2.5 7B Instruct ⛓ (deliberately the same model Hermes serves, so one model has two providers — making plan-time provider choice, and switching at a cycle boundary, demonstrable) · gpt-5.x via the operator's Codex OAuth ☁ (same-team scope carried from v3.5) · a knowledge-query offering over okf's curated Context Graph(s)**; the MacBook node is the operator's buyer running the new UI; **Hermes plays the buyer this cycle**, keeping his Qwen2.5 7B ⛓ listed as that model's second seller — plus, as a stretch, okf subscribes back to Hermes's 7B so statements flow **both directions** and the calibration data gains a second pair.
- **CP1 · Funding.** Small TRAC amounts for plan payments (short periods keep them tiny) plus Base ETH for gas, placed via config. Hermes's funding is his human's, asked in-thread.
- **CP-R · UI runthrough sign-off.** Granted after Phase 1 and **before any engine code is written**: the operator clicks through the complete static runthrough — buyer and seller journeys, desktop and 390 px — and approves it. The approved runthrough is the binding UI contract; deviations during integration come back to this gate.
- **CP2 · Mainnet go.** Only after the devnet rehearsal — including every drill in Appendix C under compressed periods — is green. Also fixes the **mainnet period length** (default: 1 day for the funded run; weekly/monthly are config, proven on devnet at minutes-scale).
- **CP3 · Stripe test keys** (optional, gated): sandbox keys into the secret store to run the fiat spike — recurring test charge → entitlements → simulated chargeback revokes remaining ceiling. Skippable without blocking anything else.
- **CP4 · Buzz access** — carried from v3.5 unchanged; smoke post-and-read before relying on it.
- **CP5 · Sign-off.** Operator clicks through the live UI (meters, statement line, storefronts) and reviews `REPORT-v5.md`.

---

## Phase 0 — Bootstrap & recon (self-serve)

Operator hands over this prompt plus paths to the spec docs if not already committed. You: branch from the P4 commit → verify specs present → map what P4 already built vs. the brief (gap list into `PLAN.md`) → **migration plan for the tab rail**: public tab routes removed (probe → 404), tab ledger archived read-only, the per-leg verifier modules extracted into the dispute engine (they are not deleted — they are demoted). Stop at CP0.

## Phase 1 — UI runthrough first (before any engine code)

The whole product goes on screen before anything runs. Extend `docs/ui-spec/` with the new and changed surface specs and their UI-COPY keys, then build **static mockups of every surface** (tokens + copy + fixture data, no wiring) and assemble them into a **navigable runthrough** — an index page that walks both journeys in order: buyer (Subscribe → composer → catalog & model page → playground with the inline 402 → Plans & meters → statement line → storefront) and seller (ask editor → subscriber list → statement queue → revenue wallet). Run the §Loop (gallery, Playwright shots at both widths, written critique) on the mockups themselves. Then stop at **CP-R** — no engine code before the operator has clicked through and signed off.

Reference captures for this phase: keep the OpenRouter set, and add **`claude-usage.png` — Claude's own usage screen** (behind login, so the operator supplies it; if absent, follow the idiom as written in the acceptance criteria). That screen is the meter's structural reference: scope bars, "X% used", a plain countdown (voiced as Expires in ours), the approaching-limit state, and a limit message that offers options.

The surfaces the runthrough must cover:

- **Subscribe → Key onboarding** (replaces Fund → Key): start from a built-in plan template (ship one or two) or open the composer, one gated payment per seller, mint key. KPI instrumented: fresh node → first metered completion.
- **Plan composer** (new — this is where a human chooses between sellers): allocate a period budget across models **and query services**; per offering, **one provider is chosen** (the cheapest pre-selected; the buyer can pick another from the same list); a live preview per offering — "5M tokens" for models, "N query units" for knowledge, exact at the chosen provider's ask — plus the per-seller payments the plan will make. Editable at top-up and at cycle boundaries.
- **Catalog & model page, subscription-aware**: covered models carry the standard chip ("76% left"; exact amounts and expiry on tap); the model page's per-seller rows gain a covered/not-covered state, each uncovered row a plain **Add to plan** action — so comparing and switching sellers of one model is a browsing act, not a config file.
- **Plans & meters** (replaces Treasury): the Claude usage idiom, expiry-voiced — **one bar per selected model and per knowledge service** ("Qwen 14B: 24% used · Expires in 12 days"; "okf knowledge: 9% used"), a **display-only** plan summary line above them; expiry countdowns, an approaching-limit warning, top-up, an expired state with a "start a new period" path, and the ceiling-hit fork (top up / switch models) rendered plainly on the 402.
- **Statement line**: "This period: our count 1,238,400 · provider count 1,238,400 ✓", a freshness line beneath it ("Counts agree ✓ · checked 4 min ago", fed by SWM checkpoints), dispute state when the counts disagree, and a drill-down to the published statement KA.
- **Node storefront page** (new): everything a node serves — including its query offerings over curated Context Graphs — its asks and next-cycle changes, reputation, uptime, statement-verified volume — the second discovery axis from the brief.
- **Playground, allowance-in-context**: streaming stays; the per-message verified chip is retired. The model switcher shows **remaining allowance beside every model** ("Qwen 14B · 76% left"); each response carries a subtle served-by line ("via okf-mainnet ⛓") so routing stays transparent without per-message ceremony; a mid-chat ceiling hit renders the 402 fork **inline in the conversation**, never a dead-end; verification surfaces at the statement line and spot-check flags only.
- **Seller Operate**: ask editor with "takes effect next cycle" semantics, subscriber list, statement queue, subscription-revenue wallet balance (distinct from ops wallet, visibly), calibration export button.

## Phase 2 — The subscription engine

Build against Appendix A's objects:

- **Plans & ceilings.** Purchase computes each (offering, provider) ceiling **exactly**: allocation ÷ the chosen provider's committed ask — no floor-vs-better distinction, because there is no runtime routing to a cheaper seller. Price frozen for the cycle. Top-up mid-cycle extends ceilings (a new payment; nothing refundable). At period end the remainder expires with an explicit `expired` journal entry. Ceilings are strictly per offering in native units — tokens for models, query units for knowledge; **no shared or value-denominated pool exists in P5**. All meters follow identical rules — admission/delivery decrements, expiry, top-up, the fork.
- **Ask commitments.** A seller's ask is a **per-period commitment** published in the offer KA; edits queue for the next cycle boundary. Existing subscribers keep their frozen price to period end.
- **Query Cost Schedule & guards.** Freeze schedule v1 as a content-addressed KA the offer references (the tokenizer-bundle move applied to queries; drift ⇒ statement dispute). Both seats compute each query's units from the identical query bytes. Decrement semantics: base + complexity on **admission**, results weight on **delivery**; a query aborted by the seller's guards (per-query timeout, scan budget) keeps its admission cost and bills nothing further — heavy-query abuse stays expensive for the abuser, recountability stays intact.
- **Both-sides metering.** Seller decrements on serve; buyer counts in parallel; failed or undelivered calls decrement nothing on either side (extend the P4 lifecycle: no delivery, no decrement).
- **DKG substrate & reconciliation cadence.** Two Context Graphs, by name: a **Marketplace Registry CG** (open) holds Model KAs, offer KAs and their asks, tokenizer bundle KAs, and the Query Cost Schedule KA — ask updates bounded to one per offering per cycle by the commitment rule; a **pair CG** (curated, exactly the two members) is auto-created at first subscription and carries reconciliation. Cadence maps onto the memory layers: meters are local Working Memory (continuous, free); the seats exchange small signed **checkpoints** — running totals per offering, hash-chained — over **SWM gossip in the pair CG**, never published (zero TRAC), on an **activity-driven** cadence (default: every 100 billable calls or 15 minutes of activity, whichever first, jittered; idle pairs send nothing; compressed test periods scale the parameters); the once-per-period statement is the **only Verifiable Memory publish** in the clean path. A checkpoint mismatch narrows any dispute to that interval; an *unresolved* divergence publishes an interim dispute statement to VM immediately rather than waiting for period close. Cadence parameters live in config; the UI's statement surface gains a freshness line ("Counts agree ✓ · checked 4 min ago") fed by the checkpoints.
- **Statements.** At period close, both seats produce totals per pair (nothing renews by itself — a **new period begins only with a new consented payment**; the sandbox Stripe spike is the only recurring construct); agreement → one co-signed statement, **published as a Knowledge Asset into the pair CG**, referencing the checkpoint-chain root, resolvable by both members. Disagreement → the dispute engine: per-call recount over the hash-chained logs, resolution recorded in the statement.
- **Spot-checks.** Buyer recounts 1-in-N calls (config) under the pinned tokenizer bundle in the background; a failed sample flags the pair for full-period dispute.
- **Calibration telemetry.** From day one, an export (`nsm calibration export`) emits per-epoch JSON: volumes per pair and model, ask distribution, buyer-concentration index, unused-allowance ratio, statement dispute rate, checkpoint interval statistics and divergence rate. `CALIBRATION.md` documents the schema — this is Stage 2's raw material.
- **Fixture suite:** everything in Appendix C as automated drills, plus the carried redaction and 404 probes (probe list updated: tab, deposit, refund, withdraw, settle routes all absent).

## Phase 3 — UI integration

Wire the CP-R-approved surfaces to the live engine — the runthrough is the contract, not a suggestion. One surface per commit with its live-data screenshot attached; the §Loop runs again on real data; any deviation from an approved mockup is flagged and returns to CP-R rather than shipping silently.

## Phase 4 — Devnet rehearsal, compressed periods

Two scratch seats plus the real code path, periods set to minutes. Run every Appendix C drill and record the UI showing each honestly — the statement-mismatch drill is this prototype's version of the v3 incident: **a seller inflating its count must be caught by the statement reconciliation, escalated to the per-call dispute, and resolved on screen.** Earns CP2.

## Phase 5 — Mainnet funded cycle, seats via Buzz

Post the buyer runbook to #neurosymbolic-ai (branch + SHA echo before any payment). Hermes: composes a plan spanning okf's offerings (and his own 7B if listed), pays per seller (his human gates it), works through his agents against the ceilings **with a single key — capturing `/v1/models` listing every covered model across sellers, and completions from at least two models of two different sellers **plus one knowledge query**, all through that one key: the one-key multi-model-and-query proof for the report** — exhausts one model's ceiling on purpose — while the knowledge meter keeps working — to exercise the fork and the switch path, and co-signs statements at period close. Stretch: the reverse subscription okf → Hermes for both-direction statements. At least **two full period boundaries** on mainnet: one clean reconciliation and statement, one period end with visible expiry — the next period started by a new consented payment. Receipts, statement KA UALs, and the chain-footprint audit in-thread.

## Phase 6 — Stripe spike (only if CP3 granted)

Sandbox recurring charge → entitlement mapping → test chargeback revokes remaining ceiling → all against devnet. Nothing more.

## Phase 7 — Evidence & calibration

`REPORT-v5.md` in house style: journey tables for the new rail, the drill records, the chain-footprint audit (Basescan: exactly one tx per buyer per seller per period), the new conservation identities from Appendix A holding from both seats, statement KAs resolvable by either party, the KPI, the calibration export summarized, and the limitations stated plainly — seller-held custody and seller-accrued float until the RFC, listed under known-and-accepted, not hidden.

---

## Appendix A — objects & invariants

```
AskCommitment   seller · offering (model | query service over named CGs)
                · ask: µTRAC/token, or µTRAC/query-unit (units per the
                  pinned Query Cost Schedule KA) · effectiveFromCycle
Plan            buyer · period (config: minutes…monthly; product default
                monthly) · allocations[] · fundingSource ∈ {trac_payment |
                conviction_allowance* | fiat*}   *reserved seams, not built
                in P5 — PCA funding is RFC-gated, fiat is the CP3 spike only
Allowance       (offering, seller) · unit ∈ {tokens | query units}
                · guaranteed (= allocation ÷ frozen ask) · consumed
                · state ∈ {active, exhausted, expired}
                — always per offering; never shared, never
                value-denominated (plan totals are display only)
Statement       pair · period · buyer/seller counts itemized per
                offering & unit · resolution
                ∈ {agreed, disputed→resolved} · co-signatures · published KA
Checkpoint       pair · periodId · seq · running totals per offering
                 · prevDigest · both signatures — SWM only, never VM
Journal entries paid · consumed · expired · toppedUp · disputed
Invariants      I1  per pair: buyerCount == sellerCount at close (or a
                    recorded dispute resolution)
                I2  Σ per-key consumption == plan consumption (key-conservation)
                I3  paid == consumed_value + expired_value per ceiling per cycle
                I4  chain txs per buyer per period == subscribed sellers
                I5  every 'consumed' journal entry references exactly
                    one (offering, seller) allowance — no cross-
                    offering decrements exist
                I6  clean path: exactly one statement KA per pair per
                    period reaches Verifiable Memory; checkpoints
                    never do; interim VM publishes occur only on
                    unresolved divergence
Probes → 404    tab · deposit · refund · withdraw · settle · credit · release
```

## Appendix B — Hermes runbook must-contain

Branch + SHA echo before any payment · plan composition spanning ≥2 models + the query offering, **each with its own ceiling** · per-seller payment gates worded for his human · ceiling-hit fork exercised · statement co-signing at close · dispute etiquette (exact counts and log digests in-thread, never improvise) · calibration export shared back · his node's rule-7 pack.

## Appendix C — drill list (devnet, compressed periods; all recorded)

Ceiling hit → 402 fork (top up / switch models) · period end with visible `expired` journal, the meter entering its expired state, and a new period starting only via a new consented payment · provider-choice drill: two providers of one model compared at plan time, selection binds, a switch lands only at the next cycle; a chosen provider taken offline fails the call with nothing charged · ask change lands only at next cycle · **statement mismatch: inflated seller count → reconciliation fails → per-call dispute → resolution recorded** · checkpoint drill: a mid-period divergence is flagged within one checkpoint interval and the dispute scope is that interval, not the period · cadence cost audit: the clean path publishes exactly one statement KA per pair per period (I6) · separate-meters drill: an inference call decrements only its model's meter and a query only the knowledge meter; one ceiling hit leaves the others usable and the fork offers the switch · query drills: an aggregation-heavy query visibly consumes more units than a simple lookup and both seats' unit counts match in the statement; a guard-aborted query decrements only its admission cost; the 402 fork applies at the query ceiling too · spot-check catches one tampered call · top-up extends, refunds nowhere · Stripe chargeback revokes ceiling (if CP3) · statement KA resolves from the counterparty node · I1–I4 checked continuously · 404 probe sweep.

---

*Begin with Phase 0 and stop at CP0. The v3 lesson still governs: the best evidence is a failure handled honestly — this cycle's designed failure is the statement mismatch, and the UI must be able to tell that story on screen.*
