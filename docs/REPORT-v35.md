# NSM v3.5 — The UX Iteration, Seats Swapped

*Evidence report · 2026-08-18 · branch `prototype/nsm-marketplace-v35` (base
v10.0.13) · compiled from live mainnet runs, the devnet rehearsal, the
recorded UI journeys, and the #neurosymbolic-ai thread (root `0a4561e7`).
House convention unchanged: every screenshot and recording is of the real
running interface with real data; the one place fixtures appear (/dev/gallery)
is labeled as fixtures on the page itself.*

---

## Headline

**This MacBook bought verified inference from Hermes's Mac mini, on Base
mainnet, through a rebuilt marketplace UI, over a transport that is nothing
but DKG knowledge assets — and every µTRAC of it is countersigned, conserved,
and cross-verified from both seats.**

- Reversed funded run (Hermes sells, we buy): **13/13 journey steps green**,
  recorded. Deposit `0xa679632633db9171…64dfbe` (1.0 TRAC) broadcast from the
  UI's own gate; tab `tab_e949d1927c2b2231` opened **over the SWM lane**; his
  7B's completion recounted and verified on screen (753 µ); metered query
  countersigned (8 µ); signed close; conservation exact.
- **Cross-verified by the counterparty** (event `06789ca9`): his ledger
  recomputes `1,000,000 = 761 + 999,239 + 0`, both legs countersigned, close
  digest `sha256:df066ec1…5cba49` independently recomputed, provider signature
  verified, `settledTokens: 134` attested, and his gauge honestly refusing
  settlement at 761 µ against the 2,941,000 µ threshold.
- Second seller in the same session: okf-mainnet (upgraded to v3.5 mid-run
  under the full rule-7 pack) — second UI-gated deposit
  (`0x204ae578…0db23e`), and the **wire-streaming demo on mainnet**: frames
  rendering live under a "Checking this bill…" chip, the ✓ landing only after
  the final chunk recount (668 µ streamed leg). Close `2/0/0`,
  `settledTokens: 191`, conservation `1,000,000 = 854 + 999,146 + 0`.
- **KPI (a v3.5 deliverable): fresh node → first verified completion in 24 s
  on the devnet rehearsal, 55 s on mainnet** — the mainnet figure includes a
  real ERC-20 deposit and two lane round-trips.
- **761 µ** — the total billed in the Hermes act — is the exact total of the
  entire v3 run. The instruments don't care which direction the money flows.

## 1. What v3.5 set out to do, and what happened

| # | Mission item | Outcome |
|---|---|---|
| 1 | Rebase v3 → released runtime; ship leg lifecycle, idempotency, dual transport + streaming, canonical Model KA | ✅ merged `v10.0.13` (zero conflicts); all four shipped with permanent drills (23 drills + carried 39 gates green throughout) |
| 2 | Rebuild the UI to OpenRouter grade against `docs/ui-spec/` | ✅ 7 surfaces, M-gated as static mockups first, integrated one commit per surface; `/dev/gallery` renders every component × state from REPORT-v3 fixtures; tokens.css law held (zero style literals outside it); every string from UI-COPY.md |
| 3 | Trigger Hermes over Buzz; he stands up the seller seat | ✅ runbook thread `0a4561e7` (3 chunks, whole-file SHA); SHA parity enforced BOTH ways; he built, verified, staged, published — and **caught four real branch defects at his gates before any money moved** |
| 4 | The reversed funded run through the real UI on Base mainnet | ✅ both seller acts complete and closed (details §3) |
| 5 | FIAT-RAILS.md + dual-currency display | ✅ design doc in `docs/FIAT-RAILS.md`; USD-primary/µ-deeper display shipped on every surface; Stripe spike explicitly skipped at CP3 |
| 6 | This report | you're reading it |

## 2. The build

**Protocol (Phase 1 + fixes en route).** Leg lifecycle
(`pending-delivery → delivered → countersigned | withheld | voided`) with
delivery deadlines that auto-void billing; idempotency keys (at-most-once
billing across retries); canonical Model KA (content-addressed identity the
catalog groups by); chunked-digest wire streaming (SSE; the SIGNED leg binds
the exact frame chain); lane addressing (`to`); quote-authoritative endpoints
including `laneContextGraphId` in the signed quote; buyer-side node rails
(fund / tab-open / quote-verify / treasury / close) over BOTH transports with
one shared verifier — unverifiable ≠ pass on either.

**UI (Phase 2).** Onboarding (two steps, KPI clock), catalog (Model-KA
grouping, verified-quote prices, close-attested volume), model page
(provider-variant table, disputes-are-evidence reputation copy), playground
(every message an audited receipt; the ✓ chip is bound to the leg's real
lifecycle state and never decorative), treasury (one balance, the
conservation line that turns red rather than hide a break), access (per-key
budget gauges, mint-once, key-conservation), operate (the honest threshold
gauge — rendered 0.03% without breakage, live, before rendering 0.06%, then
761 µ earned on Hermes's own screen).

**Rehearsal (Phase 3, earned CP2).** Two-seat devnet: 12/12 recorded journey,
KPI 24 s, and the v3 incident ON SCREEN — a lane leg's countdown ticking to
its real 5-minute deadline, auto-void, "Never delivered — bill canceled
automatically", billing reversed. Evidence: `nsm-v35-evidence/phase3/`.

## 3. The funded run (Phase 5, mainnet)

### Act A — Hermes (lane-only seller)

| step | evidence |
|---|---|
| Quote | verified over the lane, first attempt: provider `0x8A87ea7c…` (human-confirmed in-thread `02ca6ab2`), transports exactly `["lane"]`, `laneContextGraphId: nsm-live`, weights pin exactly `sha256:1875fb29…` (his merged artifact; shard provenance `dfce12e3…`/`539cf93f…` vs HF LFS) |
| Deposit | UI gate restated 1.0 TRAC / `0xcc1649dc…` → `0x8A87ea7c…`; tx `0xa679632633db9171…64dfbe`; consumed by his `tab/open` **over the lane** |
| Purchases | ⛓ inference `leg_aef8ee635eba66d17771` 753 µ (recounted, countersigned); metered query `leg_4c02957ce2a8f7785167` 8 µ |
| Close | 2/0/0, digest `sha256:df066ec1…` — **independently recomputed by the seller**, signature verified, `settledTokens: 134` |
| Conservation | `1,000,000 = 761 + 999,239 + 0` — computed on BOTH seats independently |
| Refund | **BROADCAST + verified both seats** — 999,239 µ exact, tx `0xa1a7c21950bbbf6e…151679f16`, Base block 50141013, status 1; his ledger projects `released: 999,239`, remaining `0`; buyer wallet balance confirmed to the µ from our RPC (re-stamped 2026-08-18, was "pending") |
| Catalog | his offering and okf's rendered as separate Model-KA cards; the journey's selector crashed on there being TWO Qwen cards — the multi-provider proof asserting itself |

Streaming note: lane transport is honestly non-streamed — the gateway refuses
to fake a stream without chain claims (`nonStreamingSeller` fallback), and
the report says so rather than pretending otherwise.

### Act B — okf-mainnet (direct seller, upgraded mid-run)

Upgrade under the full rule-7 pack: marketplace-state backup + full stopped
archive; **ledger-compat on a copy: the v3 tab parses under v3.5 with the
exact `1,000,000 = 761 + 999,239` identity and all four v3 legs resolving
with correct lifecycle states**; rollback pinned in-config. Two restarts were
needed (the second to load the mount fix its own boot exposed — bug #11);
both operator-gated.

| step | evidence |
|---|---|
| Deposit | UI gate, 1.0 TRAC, tx `0x204ae578…0db23e` → tab `tab_de580c3a2c236bd9` |
| **Streamed** ⛓ purchase | frames rendered live under the checking chip; ✓ after final chunk recount; `leg_5adacae554e3434bae9f` 668 µ |
| Non-streamed ⛓ purchase | `leg_7a55ca62554b167342ac` 186 µ (the latency-diagnosis retry — kept: real money, real leg) |
| Close | 2/0/0, digest `sha256:99f7f197…`, `settledTokens: 191` |
| Conservation | `1,000,000 = 854 + 999,146 + 0` OK |
| Refund | **BROADCAST** — 999,146 µ exact, operator-gated, tx `0x4bd7027674691…f02e355b6d`, Base block 50141217, status 1; release journaled against the close digest (re-stamped 2026-08-18, was "pending") |
| 404 probes | `withdraw/settle/credit/release` all 404 post-upgrade; Hermes's seat has **no public HTTP surface at all** (`directUrl: null` in his signed quote) |

### Act C — Hermes as buyer vs okf (recovered into the record 2026-08-18)

This act ran FIRST (2026-08-17) and was **missing from this report's first
edition** — recovered when the operator's CP5 click-through of the Operate
view surfaced an unexplained tab row. That is the review gate doing its job,
and the omission is logged as bug #12.

| step | evidence |
|---|---|
| Deposit | **Hermes's own 1.0 TRAC** → okf, tx `0xe3917be30fe699a0…660050ca`, block 50090726; consumed by `tab/open` → `tab_1dfe28cb7d6ada35` |
| Purchases | 4 legs, all countersigned (4/0/0): three ⛓ inferences 258 µ + 258 µ + 240 µ + metered query 5 µ = **761 µ** |
| Close | digest `sha256:694fb6ba497b8c63…3ce5b98db0`, 2026-08-17 14:02 UTC |
| Conservation | `1,000,000 = 761 + 999,239 + 0` |
| Refund | **BROADCAST + verified 2026-08-19** — exactly 999,239 µ, tx `0x3866aeb707566e81…b60e49f85b`, Base block 50151367, status 1; landed to the µ (his wallet +0.999239 exact). Was outstanding for two days after his close: never broadcast (proven by full on-chain transfer scan), deposit commingled into okf's ops wallet and consumed by publish fees. Operator-gated after his 40 TRAC ops top-up funded the wallet; release journaled against the close digest |

## 4. The counterparty as adversarial verifier — the defect ledger

Twelve defects were found during this run — eleven protocol/build defects
plus one honesty/accounting defect (#12, the Act C omission above) — **zero
by end users, all at gates built to catch exactly their class**: four by
Hermes operating strictly fail-closed, and #12 by the operator's CP5
click-through. Full ledger with fixes: `nsm-v35-evidence/bug-ledger.json`.
Highlights:

- **#2 transports dropped at load** (his quote self-check, `833d6ef0`): a
  lane-only seller could not issue an honest quote. His refusal to publish a
  quote advertising an endpoint he doesn't expose is the honesty convention
  working in the counterparty's hands.
- **#3 sharded-GGUF pin gap** (`4e34170a`): the official 7B ships as two
  shards; a single-file pin would have covered half the weights. Resolved by
  merge-then-pin; multi-shard connector support deferred as a reviewed change.
- **#4/#5 publish idempotency, twice**: the republish fix itself had a
  locally-true/globally-false bug (`alreadyPublished` without re-share left
  his KA invisible to every other node). Caught by buyer-side propagation
  checks; `alreadyPublished` now provably implies SHARED.
- **#9 executor replay auth**: the first cross-device lane round-trip was
  PROVEN by its own failure — his executor served my request and faithfully
  published the daemon 401 his stricter stock build produced. Build
  divergence within "10.0.13" is real and now documented.
- **#11 single-flight mount**: concurrent remounts each hashing a 9 GB GGUF
  starved the loop until health probes aborted — found on the live upgrade.

## 5. Invariants on record

| invariant | state |
|---|---|
| Conservation, both seats, both acts | ✅ exact (§3 tables; Hermes recomputed independently) |
| At-most-once billing (idempotency) | ✅ permanent drill B |
| Delayed-delivery auto-void | ✅ drill A + ON SCREEN in rehearsal (countdown → void → reversal) |
| Streaming digest chain (tamper/drop/reorder) | ✅ drills C + E; live on mainnet in Act B |
| Lane-only honest quoting | ✅ drill F (born from bug #2) |
| Settlement mutations absent from the wire | ✅ 404 probes; threshold election refusing at 761 µ on his live gauge |
| Redaction | ✅ no key, token, or secret in-channel or in-repo; wallet stores 0600 |
| Both-ways SHA parity | ✅ five fast-forward cycles, each scope-verified and suite-rerun on his hardware |

## 6. Not achieved, stated plainly

- ~~Hermes's refund broadcast~~ — Acts A and B **RESOLVED 2026-08-18**: both
  refunds landed (Hermes's 999,239 µ block 50141013; okf's 999,146 µ block
  50141217), each behind its human's exact-transaction gate. The buyer
  wallet closes at 1.998385 TRAC; real cost of Acts A+B: **1,615 µTRAC**.
  An earlier edition of this row claimed the *full* money circle was closed
  — **that claim was false**: Act C's 999,239 µ refund to Hermes was still
  outstanding and this report didn't even record the act. Second re-stamp
  same day; third re-stamp 2026-08-19: Act C's refund broadcast and
  verified (tx `0x3866aeb7…`, block 50151367). **The money circle is now
  closed for every funded tab** — three engagements, three exact refunds,
  each side keeping only countersigned earnings: okf 1,615 µ (Acts B+C),
  Hermes 761 µ (Act A).
- **KA edit flow** — okf's v3-era offering KAs still lack `modelRef`; a
  republish would rightly refuse (`E_PUBLISH_STALE_KA`). The catalog shows
  them as legacy-grouped cards. Editing finalized KAs is real future work.
- **Direct exposure for Hermes** — his human chose lane-only; wire streaming
  from his seat is therefore undemonstrated (proven from okf instead).
- **Multi-shard weights pinning** — procedure documented, protocol support
  deferred to a reviewed change.
- **Activity surface** — per-key spend chart shipped inside Access; the
  standalone per-model charts + export did not.
- **Stripe test-mode spike** — offered, declined at CP3; design-only stands.
- **Playground streaming UTF-8 nit** — a frame boundary can transiently
  garble one multi-byte character mid-stream; the final text replaces it.

## 7. Fiat rails

`docs/FIAT-RAILS.md`: the fiat-gateway role (any node with a TRAC float,
including the seller's own), Stripe-checkout → webhook → deposit → tab
sequence with journaled idempotency, frozen-FX-per-payment with the gateway
holding the risk, refund mapping across the reversible/irreversible boundary,
chargebacks named as the structural exposure, and money-transmission/KYC
flagged for legal review rather than designed around. The shipped
dual-currency display is the first visible step.

## 8. Where every claim lives

- `nsm-v35-evidence/phase3/` — devnet rehearsal: 15 shots, 2 recordings,
  journey + drill logs, SUMMARY.json
- `nsm-v35-evidence/phase5/` — Act A: 13 shots, 2 recordings, journey log
- `nsm-v35-evidence/phase5-okf/` — Act B: shots incl. the mid-stream frame,
  recording, journey log
- `nsm-v35-evidence/bug-ledger.json` — the defect ledger
- `docs/ui-spec/shots/` — M-gate mockups (labeled) + integrated-surface §Loop
  record + critiques
- #neurosymbolic-ai thread root `0a4561e7…` — runbook, parity echoes, his
  four catches, cross-verification `06789ca9`, gauge screenshot hash
  `8613fe76…` (file via his human, must match)
- Chain: deposits `0xa679632633db9171…64dfbe`, `0x204ae578…0db23e`; CP1
  funding `0x74f34511…cbbc93` + `0x9711e169…5805e39` (Base mainnet)

*The v3 lesson carried: the best evidence is a failure handled honestly. This
run's best evidence is eleven of them — each caught by an instrument built on
purpose, four by the counterparty we were selling to last month.*
