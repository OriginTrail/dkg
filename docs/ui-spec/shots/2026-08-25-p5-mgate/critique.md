# §Loop critique — P5 M-gate mockups, round 1 (2026-08-25)

Reviewed: 05-plans-meters (desktop), 02-plan-composer (mobile), 09-operate-v5
(mobile) in detail; all 20 shots skimmed.

**Passes:**
- 05 meters: all four states render; Claude idiom lands (per-scope bar,
  "X% used", plain reset phrasing, warning color at 87%, fork as three
  buttons); shared bar itemizes with values summing to the bar (I5 visible);
  expiry line phrased as recognized-not-returned. ✔ acceptance boxes hold.
- 09 operate: revenue wallet visibly separate (distinct border) with the
  never-holds-customer-funds line; ask editor shows current AND queued value;
  statement queue itemizes before signing; archive link present. ✔
- 06 statement, 07 storefront, 03 catalog, 04 model page, 08 playground,
  01 onboarding: states present, no-refund line at the gate, inline fork in
  conversation flow, two-seller rows independent. ✔ on skim.

**Defect (fix before CP-R):**
1. 02 composer @390px — offering rows use flex-wrap; when the label wraps,
   the price drops to a new line LEFT-aligned, producing ragged rows
   ("~$0.10/1M" and "15.24 µ/unit" dangle). Fix: `.off-row` becomes a
   grid with the price cell right-aligned at all widths.

**Round 2:** fix applied, composer re-shot both widths; raggedness gone.

**Round 3:** payments summary overflowed at 390px (nowrap vs long line) —
now stacks below 640px. Re-shot; clean. All acceptance-relevant states
verified at both widths. → CP-R.

**Round 4 (course correction):** all 10 pages re-framed inside the node UI
shell (PanelLeft-style sidebar + header tabs + path badge + flag footer) per
rules 11/12; full re-shoot at both widths. Verified on 05-meters desktop:
chrome present, active states correct, content unchanged; mobile collapses
the sidebar and keeps the header. Mounting is now evident in the evidence.
