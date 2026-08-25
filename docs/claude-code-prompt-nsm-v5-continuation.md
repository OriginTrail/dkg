# Prompt for Claude Code — P5 continuation: CP-R closes, rebase, then build

CP-R is **granted with two riders**. The runthrough's content stands; no further gate loop. But the gate cycle changed the *design*, not just the pixels — six consequential decisions landed while the mockups were in review, and some of them invalidate engine assumptions you may have already scaffolded. This prompt: (1) closes the riders, (2) rebases your understanding and the codebase on the consolidated delta, (3) resumes Phases 2 → 7 of the master prompt.

**Documents first.** The operator supplies the *current* `claude-code-prompt-nsm-v5.md` and `cpr-correction-v2.md` — both were edited outside your session and your local copies are stale. Replace the repo copies, commit them, and treat the master prompt's Appendix A (objects, invariants I1–I6, probes) and Appendix C (drills) as the authoritative build spec. Where your session memory disagrees with those files, the files win.

---

## Step 1 — Close the riders (first commits of this continuation)

1. **Re-stamp the runthrough index.** `index.html` still says "shared drawdown itemized" — a stale-status defect of exactly the kind rule 5 forbids. Fix it, grep for siblings across all mockups and docs, and note the lesson in `CORRECTION.md`: the design changed and one label didn't follow.
2. **Make string keying greppable.** Deliver the `UI-COPY.md` delta covering every string the re-shoot introduced, and adopt the annotation convention: every user-facing string node carries `data-copy="<key>"`, in mockups **and** in integrated components. Add a probe to the fixture suite: a rendered string without a `data-copy` key fails. "Zero unkeyed strings" becomes checkable, permanently.

## Step 2 — Rebase audit, before any new engine code

Scan everything already written against the delta below and produce **`REBASE.md`**: per change, what conflicts, what is deleted, what is refactored. Explicit kill-list — if any of these exist in the codebase, they go:

- shared or value-denominated allowance paths (pools, µTRAC-denominated ceilings, cross-offering decrements)
- runtime seller-routing and price-cap logic (floor-vs-better ceiling math, fallback selection)
- any auto-renewal or reset scheduling; any "Resets" string; any wait-option in fork copy
- anything refund-shaped, however internal (rule 2 is absolute)

## The consolidated delta (authoritative even if your session context says otherwise)

1. **Separate meters.** Every allowance is per (offering, seller) in native units — tokens for models, query units for knowledge. No pool exists. Plan-level totals are display aggregates, never limits. Invariant I5: every `consumed` entry references exactly one allowance.
2. **One provider per offering, chosen at plan time.** Ceilings are exact: allocation ÷ the chosen provider's frozen ask. No runtime routing, **no silent fallback** — a provider failure charges nothing and says so; switching providers lands at the next cycle. The composer pre-selects the cheapest; the model page is where comparison happens.
3. **Expiry doctrine.** Nothing renews by itself. "Expires", never "Resets"; the fork is Top up + switch-models, no wait option; period end journals `expired`, the meter enters an expired state with a "start a new period" path, and a new period begins only with a new consented payment. The sandbox Stripe spike is the only recurring construct.
4. **Query Cost Schedule.** Query units = base + static complexity of the parsed query + per-returned-result, from a pinned content-addressed schedule KA. Decrements split: admission (base + complexity) on submit, results on delivery; guard-aborted queries keep only their admission cost.
5. **DKG substrate & cadence.** **Marketplace Registry CG** (open): Model KAs, offers/asks, tokenizer bundles, the cost schedule. **Pair CG** (curated, two members, auto-created at first subscription): reconciliation. Checkpoints — signed running totals, hash-chained — ride **SWM gossip only**, every 100 billable calls or 15 active minutes (jittered, activity-driven, idle = silent, parameters in config, scaled for compressed periods). One statement KA per pair per period to Verifiable Memory (I6); interim VM publish only on unresolved divergence. The statement surface's freshness line ("Counts agree ✓ · checked 4 min ago") is fed by this service.
6. **UI contract.** The approved runthrough + `cpr-correction-v2.md` bind integration: one chip grammar ("NN% left"), USD-only primary, single consent, per-offering bars with sparkline + one projection sentence, activity list with key filter, Access page, served-by attribution, inline 402 fork. Deviations return to CP-R.

## Then resume the phases

**Phase 2 — engine**, per amended Appendix A, with the gate-cycle's *new* work items called out so nothing is assumed done: the checkpoint service (SWM emitter + verifier, chain digests, divergence flagging, interim dispute publish); pair-CG lifecycle (auto-create, membership = exactly the pair); registry-CG publishers; the Query Cost Schedule freeze + parser + guards; provider-switch-at-boundary mechanics; the expired state and start-new-period flow; no-fallback error semantics. Fixture suite: all of Appendix C, including the checkpoint drill and the I6 cadence cost audit.

**Phase 3 — integration.** The runthrough is the contract; `data-copy` keys carry into components; the freshness line wires to the checkpoint service; §Loop on live data; one surface per commit with its shot.

**Phase 4 — devnet rehearsal**, compressed periods, every drill recorded — with special attention to the four born in the gate cycle: separate-meters, provider-choice (including the offline-provider case), checkpoint divergence narrowing a dispute to one interval, and period-end expiry with the next period started only by a new consented payment.

**Phase 5 — mainnet**, per the amended seat plan: okf's four offerings (Qwen 14B ⛓, Qwen 7B ⛓, gpt-5.x ☁, knowledge query), Hermes as buyer with his own 7B listed — his plan-time choice between two 7B providers is the provider-selection demo, a boundary switch the stretch. Two period boundaries; the one-key multi-model-and-query proof; pair-CG statement UALs; freshness-line captures; the chain-footprint audit now including I6.

**Phases 6–7** unchanged: the CP3-gated Stripe sandbox spike; then `REPORT-v5.md` — which gains a **design-evolution section**: the gate cycle's decisions and their reasons (simpler-because-truer: expiry, one provider, separate meters, and the cadence that maps onto the DKG's own memory layers).

## Watch-items for calibration (instrument now, argue later)

Checkpoint divergence rate and interval fit (tune 100/15 on evidence) · frequency of interim dispute publishes (I6's "exactly one" must hold in practice) · per-offering ceiling-hit frequency (the future argument for or against a post-RFC pooled credit) · provider-switch requests at boundaries (is one-at-a-time chafing?).

## Checkpoint status

CP0, CP1 done · **CP-R granted, closes on the two rider commits** · CP2 ahead (devnet green including the new drills) · CP3, CP4, CP5 unchanged. Rules 1–8 of the master prompt carry verbatim — money gates, absolute no-refund, secrets, honesty and re-stamping, scope, loopback, ask-then-fill, Buzz.

*Begin with Step 1. The gate cycle's through-line, worth keeping ahead of you: three times the simpler wording turned out to be the truer wording — build the engine to deserve the copy.*
