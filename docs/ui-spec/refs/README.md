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
