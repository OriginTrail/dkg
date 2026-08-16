# NSM v3 — User Journeys (spec of record)

> **STATUS: DRAFT — reconstructed by the build agent at CP0, pending operator approval.**
> The operator prompt names this file as the spec of record but it was not supplied; this
> draft is derived from the prompt's Appendix A wire contract, the Phase 3/5 step references
> (A1–A3 named there), the success criteria, and Iteration-2 frozen conventions (withhold
> codes, quote invariants, conservation). On approval, delete this banner; on conflict with
> the operator's intent, the operator's correction wins and this file is amended first.

Scope: exactly what the v3 build must implement. Anything not listed here is out of scope
(streaming legs, OAuth, delegation certs, escrow, multi-offering ranking, Buzz-in-spine are
explicitly deferred).

Two provenance classes throughout:

| Badge | Class | Meaning |
|---|---|---|
| ⛓ | `weights-pinned` | Model served locally; GGUF hashed; tokenizer bundle pinned as a content-addressed KA |
| ☁ | `upstream-claimed` | Resold upstream API; model string claims an upstream model; public tokenizer bundle KA + chat-template constants pinned; counts verifiable, weights **not** |

---

## Journey A — Seller (the `okf-mainnet` node)

| Step | Name | What happens | Evidence row in REPORT-v3 |
|---|---|---|---|
| **A1** | Connect | A connector (⛓ llama.cpp loopback, or ☁ OpenAI-preset with key from secret store) is attached and health-checked over loopback only. ⛓: node hashes the GGUF and pins the tokenizer bundle from the artifact as a content-addressed KA. ☁: model string resolves the public tokenizer bundle KA (e.g. `o200k_base`) + chat-template constants. | connector health transcript; GGUF sha256; tokenizer-bundle KA UAL |
| **A2** | Price | Operator sets per-token µTRAC (inference: per-input + per-output; query: flat + per-returned-quad). Node produces the signed quote (`GET /terms` → 402 + quote) satisfying every frozen quote invariant; for ☁, the margin helper snapshots upstream $/1M vs µTRAC with the FX-freeze warning. | signed quote JSON; invariant checklist; margin snapshot (☁) |
| **A3** | Publish | Offering KA published to the DKG with `provenanceClass`, model identity, prices, tokenizer bundle ref, endpoint `apiBase`. Discoverable by UAL. | offering KA UAL + on-DKG resolution transcript |
| **A4** | Expose | Public front serves exactly the Appendix-A routes. `withdraw/settle/credit/release` are **absent → 404** (probe on record). Every post-tab route enforces EIP-191 auth (method + path + body digest + tabId + nonce). | 404 probe outputs; auth-refusal transcript |
| **A5** | Admit | Buyer posts `tab/open {txHash}`; seller verifies the deposit on its **own** Base RPC and the buyer identity KA (wallet↔node binding); tx hash is consumed (replay refused). Tab opens with the deposit as gross. | tx hash + Basescan link; identity-KA UAL; replay-refusal transcript |
| **A6** | Serve & meter | Each completion/query is served deterministically (⛓: fixed seed, temp 0, settings recorded) and metered against the frozen policy — never caller-supplied numbers. A signed leg is returned: counts · price applied · delivered-bytes digest · tokenizer bundle ref · `provenanceClass` · provider signature. Upstream 429/5xx/timeout (☁) → downstream error, **no leg**. | leg JSONs with digests; no-leg-on-upstream-failure transcript |
| **A7** | Operate | Seller watches Tabs & Usage (per-tab, per-key, per-leg outcomes incl. WITHHOLD reasons) and the threshold meter (unsettled earned vs gas/ε election threshold). | UI capture or (no-UI) ledger projection transcript |
| **A8** | Settle-or-refuse | Buyer's signed `close` is recorded. Settlement election is threshold-gated, loopback-only, mutation-enforced; below threshold ⇒ refusal on record and buyer balance stays refundable. Conservation holds to the µTRAC from the seller seat. | close digest; election verdict; conservation readout |

## Journey B — Buyer (Hermes' node, and the Phase-2 scratch buyer)

| Step | Name | What happens | Evidence |
|---|---|---|---|
| **B1** | Build & run | Clone repo, check out `prototype/nsm-marketplace-v3`, build, `marketplace.enabled=true`, run buyer node (testnet in rehearsal; `mainnet-base` live). **Echo checked-out commit SHA before spending; mismatch stops the run.** | SHA echo (Buzz event id, live run) |
| **B2** | Discover | Resolve both offering KAs by UAL; read model identity, prices, `provenanceClass`, tokenizer bundle ref, `apiBase`. Endpoint probes resolve only from the declared `apiBase`; path/origin drift ⇒ refusal. | resolution transcripts |
| **B3** | Verify quote | `GET /terms`; verify the signed quote per-invariant (signature under pinned provider key, policy versions, ceiling arithmetic, deposit note byte-exactness, tokenizer-bundle resolvability). Pass/fail per invariant on record; unverifiable ≠ pass. | invariant-by-invariant checklist |
| **B4** | Fund | Buyer asks **its own human** (never in-channel) for TRAC + Base ETH with exact amounts. Testnet: faucet auto-fund. | funding note (amounts only, no keys) |
| **B5** | Deposit & open | Human-gated on-chain deposit (amount, from, to named); then `tab/open {txHash}` + identity KA. | tx hash + Basescan link; tab id |
| **B6** | Mint key | Buyer mints an `nsm_k_…` gateway key **for itself** with scopes {budget µTRAC, expiry, model allowlist, query y/n, rps}. Key hashed at rest, shown once, never the deposit key. | mint transcript (key redacted to prefix) |
| **B7** | Purchase | Via its gateway: **one ⛓ inference + one ☁ inference + one metered knowledge query** (the three purchases). Signed legs received for each. | 3 leg JSONs; the 2 completions verbatim |
| **B8** | Recount & decide | For every leg, buyer-local verification trusting nothing asserted: delivered-bytes digest, tokenizer-bundle match, independent token/quad recount, price recomputation, leg signature. All pass ⇒ `countersign`; any fail ⇒ `withhold` with exact code (`E_BYTES_DIGEST` · `E_RECOUNT_MISMATCH` · `E_TOKENIZER_DRIFT` · `E_OVERBILL` · `E_LEG_SIGNATURE`). | recount outputs; countersign records |
| **B9** | Close & verify exit | Signed `close`; then observe the refusal/refund posture: below-threshold election refused, remaining balance refundable. Conservation verified **from the buyer seat independently**. | close digest; conservation readout; receipt bundle posted in-thread |

## Journey C — Consumer through the gateway (key-holder using bought capacity)

| Step | Name | What happens | Evidence |
|---|---|---|---|
| **C1** | List | `GET /gateway/v1/models` → funded offerings badged ⛓/☁. | listing JSON |
| **C2** | Use | OpenAI-compatible `chat/completions` (and `/query`) through the gateway with an `nsm_k_…` key; usage lands on the key's sub-ledger. First co-located consumer is **Odysseus** via the implicit default key. | request/response transcript; sub-ledger delta |
| **C3** | Limits | Scope enforcement on record: revoked key → 401 on next call; budget exhausted/unfunded → 402; rps exceeded → 429. | one transcript per failure code |
| **C4** | Reconcile | Per-key sub-ledgers sum exactly to tab billed (key-conservation). | reconciliation output |

---

## Required demonstrations (Phase 2, on record before CP2)

1. One deliberately tampered leg per class ⇒ the correct WITHHOLD code (full fixture list in the prompt).
2. Conservation from both seats independently; settlement refusal at threshold.
3. Secret-redaction proof (Codex key absent from logs/legs/KAs/report). 404 probes.
4. If the v3 ledger schema ≠ Iteration-2's: migration proven on a **copy** of `okf-mainnet`'s journal.

## Offering KA — minimum shape

`nsm:ModelOffering` { `modelId`, `provenanceClass` (⛓/☁), `perInputTokenMicroTrac`, `perOutputTokenMicroTrac`, `queryFlatMicroTrac`, `perReturnedQuadMicroTrac`, `tokenizerBundle` (KA ref), `servingSettings` (⛓: seed/temp/ctx; ☁: template constants), `providerAddress`, `apiBase` }.
