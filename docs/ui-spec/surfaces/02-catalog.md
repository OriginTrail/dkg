# Surface 02 — Catalog (model cards, grouped by Model KA)

Purpose: OpenRouter's /models grid, with settlement-backed numbers.
Refs: `or-models.png` (structure/density ONLY), `node-ui-current-marketplace.png`.

## Wireframe
```
[Search…]  [Modality ▾][Context ▾][Price ▾][Provenance ▾][Transport ▾]  Sort: Settled ▾
┌────────────────────┐ ┌────────────────────┐
│ ◇ Qwen2.5 14B      │ │ ◇ GPT-5.4          │   ◇ = logo (--logo-md)
│ Qwen · text        │ │ OpenAI · text      │       monogram fallback
│ 2 providers  ⛓ ☁   │ │ 1 provider   ☁     │
│ ~$0.9–1.1 /1M      │ │ ~$4.20 /1M         │
│ 1.2M tokens settled ↗│ │ 240k settled  —   │
└────────────────────┘ └────────────────────┘
                          footer: This view cost 1 µ · why?
```

## Components
FilterRail · SortSelect · ModelCard (Logo, Name, FamilyLine, ProviderCount,
PriceRange dual-currency, SettledVolume + trend, ProvenanceBadges) ·
MeteredViewFootnote.

## Data bindings
group offerings by `modelRef` → canonical Model KA (name, family, logoRef,
modality, context) · price range across live signed quotes (never KA literals)
· settled volume + trend ← SPARQL over close KAs, cached, `catalog.volume.tip`
attribution · badge set = union of provider classes.

## States
loading (skeleton cards) · empty (`empty.catalog`) · single-provider network
(`catalog.provider.one`, never fake counts) · stale-cache (subtle "as of {t}")
· filter-produces-zero (offer clear-filters).

## Acceptance
- [ ] Grouped by Model KA — the two live v3 offerings render as TWO cards, and
      when Hermes publishes a Qwen variant it JOINS the Qwen card (3 providers → no).
      Correct: Qwen card shows "2 providers" (okf-mainnet + Hermes).
- [ ] Qwen/OpenAI/DeepSeek/Meta/Mistral logos load from `assets/model-logos/`;
      unknown family → `.logo-monogram` with 2-letter mark.
- [ ] Primary price is USD/1M; µTRAC secondary; tooltip explains FX.
- [ ] Settled volume tooltip = `catalog.volume.tip` verbatim.
- [ ] Sort by settled / price / newest all functional against live data.
- [ ] 390px: cards single-column, filter rail collapses to a sheet.

---

## P5 amendment — subscription-aware catalog

Covered models carry a remaining-allowance chip ("3.8M left · resets 12 d" —
`meter.line.model` compact form). Uncovered models render normally with the
`model.buy` action replaced by **Add to plan**. Sort/filter unchanged.
Acceptance additions:
- [ ] Chip appears only on models with an active ceiling; absence ≠ zero.
- [ ] Chip numbers come from the same projection as surface 09's bars.
