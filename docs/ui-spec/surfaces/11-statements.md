# Surface 11 — Statement line & dispute drawer

**Mount:** node UI · Plans (buyer) · Operate statement queue (seller) · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: verification's new home. One line per pair per period; drill-down
to the published statement KA; dispute state when counts disagree. The
per-message chips are retired — this line plus spot-check flags carry the
whole honesty story. Fixtures: `p5.statement`.

## Wireframe
```
This period: our count 1,238,400 · provider count 1,238,400 ✓
  ├ Qwen2.5 14B: 1,200,000 / 1,200,000 tokens
  ├ okf knowledge: 4,200 / 4,200 query units
  ├ Spot-checks: 14 sampled, all matched
  └ Statement published — view the Knowledge Asset ↗

(disputed)
Counts disagree: ours 1,200,000 · theirs 1,274,000 — dispute opened
  └ Resolved: per-call recount over hash-chained logs:
    1,200,000 confirmed; seller count corrected — recorded in the statement
```

## Components
StatementLine (`stmt.line.ok` / `stmt.line.wait` / `stmt.line.disputed`) ·
ItemizedDrawer (per-offering rows, both units; shared allowances itemize
value too — I5) · SpotCheckRow (`stmt.spot.*`) · DisputePanel (the demoted
P4 verifier output: recount table over hash-chained logs, withhold-code
vocabulary reused in drawer) · KaLink (`stmt.ka` → resolvable UAL).

## Data bindings
line ← period statement object · drawer rows ← itemized counts, both seats ·
dispute panel ← dispute engine result · KA link ← published statement UAL,
resolvable from EITHER party's node.

## States
period-open (`stmt.line.wait` with countdown) · agreed (✓) · disputed ·
disputed→resolved · spot-check-flagged.

## Acceptance
- [ ] Agreed line shows both counts explicitly — never just a checkmark.
- [ ] Disputed state names both counts and links the dispute panel.
- [ ] Resolution text renders from the recorded statement, not synthesized.
- [ ] KA link resolves from the counterparty's node too (drill in Phase 4).
- [ ] Gallery covers all five states.
