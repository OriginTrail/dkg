# refs/ — reference screenshots (operator supplies these)

Claude Code cannot browse to competitors from inside the build. The operator
drops screenshots here **before Phase 2**; Claude Code matches their
**structure, density, and hierarchy — never their colors, brand, or pixels.**

## Capture list

| File | What to capture |
|---|---|
| `or-models.png` | openrouter.ai/models — the grid: card anatomy, filters rail, sort control |
| `or-model-detail.png` | one model page — the provider table columns and density |
| `or-chat.png` | openrouter.ai/chat — message layout, model switcher placement |
| `or-credits.png` | credits page — how one balance + top-up is presented |
| `or-rankings.png` | rankings — leaderboard row anatomy |
| `node-ui-current-*.png` | the node UI today (Marketplace, wallets, dashboard) — so the new surfaces extend the existing look, not fight it |

Mobile variants welcome as `*-mobile.png`.

## Annotation convention

- Red marks/arrows = "copy this structure / spacing / grouping."
- Blue marks = "ignore this region."
- Anything subtler → a sidecar note: `or-models.notes.md` next to the image.

## Rules

- Reference images are **inspiration, not assets**: no pixels, logos, or brand
  colors may be lifted from them into the build.
- If a needed reference is missing, Claude Code asks at CP0 rather than
  improvising the layout from memory.

---

## Capture record (2026-08-17, Phase 0 — supersedes "operator supplies these")

Per the v3.5 prompt (which wins on conflict), the reference set was
**self-captured** with Playwright, public pages only:

| File | Source | Viewports |
|---|---|---|
| `or-models(.png/-mobile.png)` | openrouter.ai/models | 1440×900 · 390×844 |
| `or-model-detail(-mobile)` | openrouter.ai/openai/gpt-4o | 1440×900 · 390×844 |
| `or-chat(-mobile)` | openrouter.ai/chat | 1440×900 · 390×844 |
| `or-rankings(-mobile)` | openrouter.ai/rankings | 1440×900 · 390×844 |
| `node-ui-current-{dashboard,marketplace,operate}.jpg` | live okf-mainnet UI, real funded-run data (2026-08-17) | ~1538×784 |

Not captured: `or-credits.png` (login-gated — optional per prompt; operator may
supply). Known blemish: a cookie banner overlays the lower-right of
`or-models.png`; structure above it is fully legible. Operator annotations
(red = copy structure, blue = ignore) remain welcome on any of these.
