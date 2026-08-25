# Surface 06 — Access (keys for agents)

**Mount:** node UI · Access (primary nav) · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: the account console for Hermes/OpenClaw-style sharing, with the
budget discipline the Codex pattern never had.

## Wireframe
```
[+ Mint key]
Name           Key        Budget            Models      Q  rps  Last   
openclaw-main  nsm_k_9f…  ▓▓▓░ 61% of 250k  Qwen ⛓ …   ✓  2    2m ago  [Revoke]
  └ detail: spend chart · This key's charges add up ✓ · expiry 30d
```

## Components
KeyTable · BudgetGauge (linear; --gauge-over at cap) · ScopeChips (models,
query toggle, rps) · MintModal (reuses onboarding KeyMintForm; `onboard.key.once`)
· KeyDetail (per-key spend chart, sub-ledger check `key.sum.ok`) · RevokeConfirm
(`key.revoked` semantics stated: stops at next call).

## Data bindings
keys ← gateway keystore (hashes; plaintext only at mint) · gauge = per-key
sub-ledger spent vs cap · `key.sum.ok` = live check that Σ per-key sub-ledgers
== tab billed (key-conservation) — red + diagnostic on mismatch · last-used ←
gateway log.

## States
empty (`empty.keys`) · exhausted (gauge --gauge-over, `key.exhausted`) ·
revoked (row grayed, semantics string) · expired.

## Acceptance
- [ ] Mint shows plaintext exactly once; table forever shows prefix only.
- [ ] Cap-hit renders `key.exhausted` and the agent-side 402 maps to `err.402.budget`.
- [ ] Key-conservation check visible per key and turns red on fixture break.
- [ ] Revocation reflected ≤ next call in the rehearsal recording.

## CP-R revision (D1–D12, 2026-08-25)
See UI-COPY.md §CP-R revision for the binding strings. Applied here: default
journey = 3 interactions w/ ONE consent (D1) · "NN% left" chip grammar (D2) ·
USD-only primary, TRAC at consent only (D3) · composer collapses to
budget+template+Confirm with Advanced holding pooling/max-price/pins (D4) ·
fork = Top up + one line (D5) · banned-term purge (D6) · D7 expiry line ·
segmented pool bars w/ --usage-seg-*/--usage-query tokens + plain legend
(D8) · sparkline + one pace sentence per pool, amber early-exhaustion state
(D9) · playground before/after linkage w/ Pool chip (D10) · Recent-activity
list, key-filterable, on Plans (D11) · Access restored to nav + runthrough
(D12).
