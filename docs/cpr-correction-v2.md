# CP-R correction, consolidated — simplicity + following the combined burn

**Supersedes `cpr-verdict-simplify.md`.** One instruction set: a **design change** (Part 0 — separate meters), the seven simplicity directives (compressed, unchanged in substance), and the directives that keep combined consumption *followable* under separate metering. Substance remains approved; this is presentation and one missing surface. Revise, re-shoot changed surfaces at both widths, return to CP-R with a one-paragraph note per directive.

## Keep untouched

Shell + banners + state labels · payment-gate anatomy with the no-refund line · key-shown-once · revenue-wallet separation · statement drawer · the inline-fork concept · all engine work.

## Part 0 — Design change: meter inference and knowledge separately

**Inference and query no longer share a ceiling.** Each selected model carries its own token meter; each knowledge service its own query-unit meter; consumption never blends across offerings. One plan and one payment set still cover everything — but the metering is per offering, full stop. The shared, value-denominated pool is **removed from P5** (a flexible cross-offering credit can return later under the RFC's network pooling, as a seam, if ever wanted).

This is also a simplification dividend — much of the mockups' complexity traced to the pool: the shared/scoped toggle disappears (D4 shrinks), the segmented bar is unnecessary (D8 is replaced), value denomination and its µTRAC math leave the UI entirely (D3 gets stricter for free), and every meter becomes a plain Claude-style bar in native units.

## Part 1 — Simplicity (D1–D7, compressed)

- **D1** Default path = 3 interactions: Starter card → **one consent** (all provider lines under a single Confirm; N transfers execute sequentially with progress) → copy key. Composer leaves the default journey; "Customize →" opens it as Advanced.
- **D2** One chip grammar everywhere: **"NN% left"**; tap reveals exact amounts, units, expiry date.
- **D3** USD-only in the primary layer; µ figures one reveal deeper; TRAC appears only at the consent; meter breakdowns show no µ values.
- **D4** Composer = progressive disclosure: budget + template + Confirm by default; Advanced holds **provider selection per offering** (cheapest pre-selected, pick another from the list) — the pool toggle went with Part 0, and "max price" goes with one-provider-at-a-time. Router labels ("routes first", "fallback", transport tags) leave buyer rows; one footnote sentence carries it: "Each model has one chosen provider; requests go there — switch providers at the next cycle."
- **D5** Fork = one button (**Top up**) + one plain line ("or switch to Qwen 7B (92% left) · this allowance expires in 12 d"). No "wait" option — nothing renews by itself in P5, so waiting is not a choice the UI may imply. Upgrade lives on Plans.
- **D6** Jargon purge through UI-COPY only; banned in the primary layer: *metered completion, cost-schedule priced, statement-verified, epoch, provenance, scoped, price cap, unit basis*. Zero unkeyed strings.
- **D7** Delete the false line "What you don't use funds the network you're part of" → "Unused allowance expires at period end — nothing carries over." (Honesty rule: in P5, unused value accrues to the seller until the RFC.)

## Part 2 — Following the combined burn (D8–D12, new)

**D8 — Per-offering bars, one aggregate line.** Every selected model and every knowledge service gets **its own bar** in the standard grammar ("Qwen 14B — 24% used · Expires in 12 days"; "okf knowledge — 9% used"). Above them, exactly one **display-only** plan summary line ("Plan overall: 34% of this period's value used") keeps combined usage followable without a combined ceiling — it is a readout, never a limit. Tap any bar → native units and USD detail. Fix the fixture bug while you're there: gpt-5.x was missing from the itemization; it now gets its own bar.

**D9 — Show the trajectory, not just the level.** Each meter gets a small **period-to-date sparkline** (fixture data in mockups) and one projection sentence computed from the buyer's own meter — nothing new is measured: "**At this pace: runs out ~4 days before expiry**" (amber, `--gauge-mid`) or "On track to expiry" (secondary text). This is the sentence that makes a meter worth opening; Claude's usage idiom extended one honest step.

**D10 — Action moves the meter, visibly.** The playground's active selection carries its offering's chip in the standard grammar ("Qwen 14B · 76% left"; a query message moves the knowledge meter), and the mockups demonstrate the linkage with before/after states: a query message lands ("41 units" on the served-by line) → the pool chip and the Plans bar reflect it. In integration this is the same store; in mockups it is two captured states side by side. The query message's unit note stays tap-only per D6.

**D11 — Activity: the simplest way to follow.** Add a **Recent activity** list on the Plans surface (beneath the meters, or a Plans sub-tab): time · what (model name or "query") · via which provider · units · ≈$ · which key. Last 20, filterable by key. This is the ledger a human actually reads when they ask "where did my allowance go?" — and it is the buyer-side twin of the statement's itemization, live instead of at period close.

**D12 — Access joins the runthrough.** The nav shows Access; the runthrough has no such page — restore it: key list with the standard budget chips ("61% of cap"), per-key mix line ("mostly Qwen 14B · 12% queries"), mint modal reusing the onboarding key step, revoke semantics ("stops at the next call"). Per-key attribution is what connects D11's activity to *who* is burning the pool, and it existed in the v3.5 spec pack — carry it forward, simplified to D2/D3 rules.

## Re-gate acceptance (replaces the previous list)

- Default journey ≤ 3 interactions, one consent total.
- One chip grammar sitewide; USD-only primary; fork = 1 button + 1 line; zero banned terms; zero unkeyed strings; D7's line gone.
- No shared or value-denominated ceiling exists anywhere; every meter is per-offering in native units; gpt-5.x has its own bar; the plan summary line is visibly a readout, not a limit.
- Every meter shows the sparkline and exactly one projection sentence, with the amber early-exhaustion state present in the gallery.
- Hitting one ceiling leaves the other meters usable, and the fork's switch line reflects it (model switching only — the same model is never silently re-providered).
- One provider per offering at any time; comparison and selection live at plan time; a provider failure charges nothing and says so.
- Playground → meter linkage demonstrated as before/after states; pool chip in the switcher uses the standard grammar.
- Recent-activity list present with key filter; Access page restored to the runthrough index and nav-consistent.
- Expiry vocabulary throughout: "Expires", never "Resets"; the fork offers no wait option.
- Keep-list byte-identical; the diff touches presentation and the two added surfaces (activity, access) only.
