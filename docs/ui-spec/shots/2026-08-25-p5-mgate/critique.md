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

**Round 5 (convergence):** operator flagged the round-4 shell as generic —
not the DKG node UI. Rebuilt against refs/node-ui-current-*.jpg: full header
bar (DKG v10 · powered by origintrail · node identity+address · syncing/peers
· icon row), left rail (+New/Join CG buttons, CONTEXT GRAPHS|ORACLE tabs,
row-highlight nav, CG card, flag line), center tab-chips, Node Log dock,
right Agents panel (Hermes chip + message input). Layer-1 grays rebased to
the node UI's neutral palette (the rebase tokens.css always allowed). One
cascade leak fixed (page-local `.row` justify bleeding into rail nav —
shell selectors hardened). Verified: 03-catalog desktop + 09-operate desktop
read as the node UI with the mockup banner above. Mobile keeps header+tabs.

**Round 6 (CP-R directives D1–D12):** all twelve applied; full re-shoot.
Verified on 05 desktop: segmented pool + legend incl. gpt-5.x (fixture bug
fixed), tapped-segment reveal, sparklines with amber pace sentence, 1-button
fork + line, D7 line replaced, activity table + key chips, USD-only, "NN%
left" grammar. Banned-term sweep clean in buyer surfaces; seller Operate
keeps µ/tok asks deliberately (sellers price in µ — flagged in the re-gate
note). Keep-list untouched byte-wise except where directives required.

**Round 7 (CP-R feedback: clickability + one-provider selection):**
(1) Journeys are now walkable by clicking: shell rail + header tabs navigate
between surfaces on every page; all primary controls are wired (Choose plan
→ consent → key via anchors; Customize/Add to plan/Upgrade → composer;
Top up → consent; chips → Plans; statement line → statement page; activity
key chips → Access; storefront rows → model page; Operate co-sign →
statement). (2) Provider selection is singular: the Starter picks ONE
provider (okf-mainnet, $0.78/month, one transfer on the consent); the
two-line consent with sequential transfers now exists only in the composer,
labeled as the explicitly-composed case, with the note that nothing
subscribes to a second seller implicitly. Model-page footnote states adding
a provider adds exactly that one seller. Re-shot; verified 01 desktop.

**Round 8:** catalog cards were missing the serving node — added "via
<node>" lines on all five cards (inference and query), each name linking to
the node storefront; 14B corrected to its actual single provider.

**Round 9 (Part-0 consolidated correction + nav instruction):** shared pool
removed everywhere — four per-offering bars in native units (gpt-5.x now has
its own), "Plan overall: 34%" as an explicit readout-not-limit, per-meter
sparkline + single pace sentence (amber early-exhaustion on 14B), ceiling-hit
state renamed to show other meters stay usable and the fork line says so;
composer previews per-offering, pool toggle deleted from Advanced; playground
before/after now moves the knowledge meter chip (92→91% left); model page
carries ONE meter chip at the title, seller rows show "included in your
plan". Nav restructured per operator: "Neurosymbolic Marketplace ▾" parent
with Plans/Access/Operate as indented collapsible children; center tab
renamed. Verified on 05 desktop.
