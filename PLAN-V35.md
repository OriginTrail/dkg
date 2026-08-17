# NSM v3.5 — Phase 0 Plan (buyer device: this MacBook)

*2026-08-17 · Phase 0 bootstrap complete · **stopped at CP0***

## Bootstrap — done, self-serve

| Item | State |
|---|---|
| Branch | `prototype/nsm-marketplace-v35` cut from v3 tip (`2000b81b`) in a **separate worktree** `~/odysseus-dkg-proto/dkg-v35` — the live okf-mainnet plugin loads by absolute path from the v3 checkout, which stays untouched (verified) |
| UI spec pack | unzipped → `docs/ui-spec/` (tokens.css · UI-COPY.md · 7 surface specs · refs rules · gates/loop README), committed as-is (`b06a686f`) |
| CLAUDE.md | created at repo root from `CLAUDE-APPENDIX.md` (none existed) — the 10 standing UI rules now load every session |
| Specs of record | `docs/nsm-v3-user-journeys.md` present ✓ · `docs/REPORT-v3.md` copied in from the evidence repo (the actual file) ✓ |
| Reference shots | **self-captured** (Playwright, public pages): or-models / or-model-detail / or-chat / or-rankings at 1440×900 + 390×844, all real content; + 3 `node-ui-current-*` refs from today's live funded-run captures. `refs/README.md` records provenance. Not captured: `or-credits` (login-gated, optional). Committed (`02320118`) |
| CP0(c) Hermes ask | posted in #neurosymbolic-ai (event `27a73d98…`): availability, hardware/model choice, direct-vs-lane exposure |

## Recon

| | |
|---|---|
| Device | M2 Max · 32 GB · node v25.5.0 · pnpm 10.28.1 (Apple Silicon toolchain ✓) |
| Current released runtime | **10.0.13** (`npm view`); tag `v10.0.13` exists in-repo; `origin/main` at `7dfa720dd` (post-release) |
| v3 branch base | 10.0.12 — the source of the v3 runtime-skew bug (Hermes's buyer-gateway 401) |
| Live state on this device | okf-mainnet :9200 healthy (seller #2 — rule 7 applies); v3 devnet nodes present but stopped/stale; llama 14B server :8090 up |
| Buzz | prior CP4 identity + #neurosymbolic-ai membership verified reachable just now — CP4 smoke will re-run formally |
| Playwright | working with Chrome-for-Testing; the §Loop's `ui:shots` machinery is viable as-is |

## CP0 questions (defaults attached — one "yes" unblocks each)

**(a) Node state on this MacBook (buyer seat).**
*Default: fresh install from the branch* — a fresh `$DKG_HOME` (e.g. `~/.dkg-v35-buyer`) on Base mainnet. The buyer needs no legacy state, and it keeps rule-7 exposure to zero on okf-mainnet. okf-mainnet stays untouched as seller #2 unless the Model-KA migration (d) requires the upgrade.

**(b) Rebase base.**
*Default: rebase v3.5 onto tag `v10.0.13`* (the current released runtime), carrying the v3 marketplace commits on top. This kills the runtime-skew bug in my own critical path per the prompt. Alternative rejected by default: `origin/main` (`7dfa720d`, unreleased — moving target). Fallback if the rebase conflicts exceed a day's work: stay on the v3 base and run the buyer node from the branch runtime itself (fresh home = no schema clash), reporting the deviation honestly.

**(c) Hermes.** Asked in-channel (event `27a73d98…`) — availability, hardware/model, direct-vs-lane. His answer gates the seller runbook, not this checkpoint.

**(d) okf-mainnet particulars for the Model-KA upgrade.**
Known from v3: `$DKG_HOME=~/.dkg-mainnet`, manual `dkg start -f` from `~/dkg-v10010`, API :9200, plugin from the v3 checkout, kill-until-quiet restart choreography, conservation baseline `99488cff…`. *Default: defer any okf-mainnet upgrade* until Phase 1 shows whether Model-KA migration of the two live offerings strictly requires new plugin code on the seller (likely yes, late in Phase 1) — then full rule-7 pack, approved restart.

## Risks carried forward

1. Rebase 10.0.12→10.0.13 may conflict in daemon internals the plugin's auth mount-point touches (`auth.ts`) — small, known diff.
2. The §Loop demands `npm run ui:gallery` / `ui:shots` scripts that don't exist yet — Phase 2 setup work, planned.
3. Devnet rehearsal needs the two-seat stack again — v3's devnet is stale; will be recreated on the rebased runtime (this also rehearses the runtime upgrade itself).
4. Logo pack (CP3) needs license-checked assets — sourcing plan due at CP3, none bundled yet.
