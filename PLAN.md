# Prototype 5 — the subscription rail · PLAN

Branch `prototype/nsm-v5-subscriptions`, forked from P4 end commit `4fe52ac23`.
Specs of record: `docs/nsm-product-brief-and-protocol-roadmap.md` (Part 1),
`docs/ui-spec/`, `docs/REPORT-v35.md`. This file is the Phase-0 gap map and
the tab-rail migration plan. Statuses here get re-stamped as phases land.

## 1. What P4 already built vs. the brief (gap map)

### Carried forward unchanged (exists at 4fe52ac23)

| brief requirement | where it lives |
|---|---|
| Marketplace module, feature-flagged, clean boundary | `packages/marketplace` route plugin |
| ⛓ weights-pinned seller (gguf SHA, tokenizer-bundle pin, llama.cpp) | `seller/connector-llamacpp.ts` |
| ☁ upstream-claimed seller (Codex OAuth / OpenAI-compatible) | `seller/connector-codex-oauth.ts`, `connector-openai.ts` |
| Offers + canonical Model KAs published to DKG, signed responses | `seller/offering.ts` (`urn:nsm:model:sha256:…`), signed legs |
| Gateway: one OpenAI-compatible API, `nsm_k_` keys w/ budgets | `gateway/router.ts`, `gateway/keys.ts` |
| Two transports: direct HTTPS + SSE streaming, SWM lane | `seller/front.ts` SSE chain, `lane/*` |
| Buyer-side recount machinery (BPE engines, stream verifier) | `buyer/bpe.ts`, `buyer/client.ts`, `seller/streaming.ts` — **demoted to dispute engine, not deleted** |
| Leg lifecycle incl. auto-void of undelivered work | `seller/lifecycle.ts` — becomes "no delivery, no decrement" |
| UI: catalog, model page, playground (streaming), access, gallery, tokens/copy discipline | `packages/node-ui/src/ui/nsm/` + `docs/ui-spec/` |
| Idempotent publish + persisted `offeringUal` (bug #13 fix) | `plugin.ts`, `published.json` |
| Evidence/report/house conventions, bug ledger | `docs/REPORT-v35.md`, `nsm-v35-evidence/` |

### New in P5 (the build list)

| # | deliverable | phase |
|---|---|---|
| G1 | `AskCommitment` — per-period ask in offer KA, edits land next cycle | 2 |
| G2 | `Plan` object (period, allocations[], `fundingSource` seam) | 2 |
| G3 | `Allowance` — scoped (unit-denominated) & shared (value at frozen asks, one seller) with admission/delivery decrements, expiry, top-up | 2 |
| G4 | Price-cap ceiling guarantee (allocation ÷ committed ask; cheaper routing beats floor) | 2 |
| G5 | Router: request names model → subscribed-seller resolution under price cap, pins/provenance prefs; 402 fork (wait/upgrade/top-up) | 2 |
| G6 | Query offerings: Query Cost Schedule KA (content-addressed), unit computation both seats, admission+delivery decrement split, guard-abort semantics | 2 |
| G7 | Both-sides metering journals (no delivery → no decrement) | 2 |
| G8 | Statements: per-pair period totals, co-sign, publish as KA in curated CG; dispute engine = P4 per-leg verifiers over hash-chained logs | 2 |
| G9 | Spot-checks (1-in-N recount, background, flag→dispute) | 2 |
| G10 | Calibration telemetry: `nsm calibration export` + `CALIBRATION.md` | 2 |
| G11 | UI (ALL surfaces mount INSIDE the node UI bundle behind `marketplace.enabled` — nav: Marketplace · Plans · Access · Operate; see docs/CORRECTION-p5-mounting.md): Subscribe→Key onboarding (Plans empty state), Plan composer, subscription-aware catalog/model page, Plans & meters (Claude usage idiom), statement line, node storefront, playground (Marketplace tab), seller Operate v5 | 1 (mockups) / 3 (wiring) |
| G12 | Dedicated subscription-revenue wallet per seller (never ops wallet — bug-#12 made structurally unrepeatable) | 2 |
| G13 | Fixture suite: Appendix C drills + updated 404 probes + NO-EXTERNAL-JOURNEY probe (no user-journey page served from any port/path outside the node UI; dev routes carry no product nav) | 2/4 |
| G14 | Stripe spike (CP3-gated, devnet only) | 6 |
| G15 | `REPORT-v5.md` + chain-footprint audit (I4 from Basescan) | 7 |

### Brief items deliberately NOT built (Part 2 / RFC)

Pooled emissions, Query/Inference Factor, Conviction-Account spend classes,
epoch distribution, cross-seller shared credits (named in the report as RFC
motivation), production fiat, real TEEs. The app-layer scoping decision
(per-seller subscriptions under a plan; seller-held custody into dedicated
wallets; unused value accrues to sellers until the RFC) is stated in the
report's limitations, not hidden.

## 2. Tab-rail migration plan (Phase 0 commitment, executed in Phase 2)

1. **Public wire surface removed.** Routes `tab/open`, `countersign`,
   `withhold`, `close`, buyer `fund`/`treasury`/`close` rails and their lane
   request kinds are unregistered. Post-migration probe list (all → 404):
   `tab · deposit · refund · withdraw · settle · credit · release`.
2. **P4 ledger archived read-only.** On each seat, `marketplace/{tabs,legs,
   closes,journal,lane-processed,consumed-txhashes}.jsonl` move to
   `marketplace/archive-v4/` (chmod 444, SHA-256 manifest). The new rail
   writes `marketplace/subscriptions/*.jsonl` only. No migration of state:
   P4 closed clean (all tabs settled, money circle closed per REPORT-v35).
3. **Verifiers demoted, not deleted.** `buyer/bpe.ts`, stream verifier,
   recount, and lifecycle move behind a `dispute/` module boundary consumed
   by statement reconciliation and spot-checks. Public per-message verify
   ceremony leaves the UI (statement line + spot-check flags replace it).
4. **Node deployment order** (all rule-7): devnet seats first (Phase 4);
   okf-mainnet + MacBook buyer at CP2 with backup/compat/rollback; Hermes's
   node via his human with the Buzz runbook (Appendix B).

## 3. Seat plan (CP0 default)

- **okf-mainnet — seller, four offerings:** Qwen2.5 14B ⛓ (llama :8090) ·
  Qwen2.5 7B ⛓ (llama :8080; same model Hermes lists → two-seller routing
  demo) · gpt-5.x ☁ via operator Codex OAuth (carried v3.5 scope) ·
  knowledge-query over okf curated CG(s) (candidate: the curated
  marketplace/odysseus CGs; final pick at Phase 2 config).
  Payments land in a NEW dedicated subscription-revenue wallet (G12).
- **MacBook node (`~/.dkg-v35-buyer`) — operator's buyer**, runs the new UI.
- **Hermes — buyer this cycle** (seat swap): composes a plan over okf's
  offerings, keeps his 7B ⛓ listed as second seller of that model.
  Stretch: okf subscribes back to his 7B → both-direction statements.
- All local nodes are PAUSED (2026-08-23 manifest); resume happens per
  phase need, not at CP0.

## 4. Current node inventory (for CP0)

| node | home / runtime | state | notes |
|---|---|---|---|
| okf-mainnet | `~/.dkg-mainnet` / `~/dkg-v10010` (10.0.13 + v35 routePlugins dist) | PAUSED 08-23 | bug-#13 fix rides next gated restart; wallet 0x633E… 39.004 TRAC (ops — NOT the subscription wallet) |
| MacBook buyer | `~/.dkg-v35-buyer` / dkg-v35 workspace | PAUSED 08-23 | wallet 0xcc1649dc… 0.999 TRAC |
| Hermes M4 mini | his; stock 10.0.13 `9151aee8` + v35 plugin at P4 parity | last contact 08-19 (stood down cleanly) | re-engage via #neurosymbolic-ai after CP4 smoke |
| devnet pair + hardhat | `dkg-v35/.devnet`, :8556 | PAUSED | Phase 4 resumes with compressed periods |
