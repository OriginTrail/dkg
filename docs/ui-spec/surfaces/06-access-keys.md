# Surface 06 — Access (keys for agents)

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
