# APPEND THIS TO REPO-ROOT `CLAUDE.md` (UI rules — every session, every time)

## UI work — standing rules

1. **Read `docs/ui-spec/` before touching UI code.** Tokens, copy, surface
   specs, and refs are the authority; this prompt's memory is not.
2. **Tokens are law.** No color, spacing, radius, shadow, or duration literals
   outside `docs/ui-spec/tokens.css`. Components bind to Layer-2 semantic
   names only.
3. **Copy comes from `docs/ui-spec/UI-COPY.md` by key.** A string not in the
   table doesn't ship — add it to the table first, then use it. Plain words
   first; exact µTRAC / digests / codes one reveal deeper, never hidden.
4. **Every state, every surface.** empty · loading · error · partial ·
   success · and the lifecycle set (checking / verified / pending-delivery
   with countdown / blocked / voided). A surface missing its empty or error
   state is not done.
5. **Look at your own work.** `/dev/gallery` renders every component × every
   state from `fixtures.json` (real REPORT-v3 numbers). `npm run ui:shots`
   (Playwright, 1440×900 + 390×844) + a written critique, iterated until the
   surface's acceptance boxes all check — before any human sees it.
6. **Mockup gate before integration.** Static HTML mockup (tokens + copy +
   fixtures) approved by the operator per surface; then integrate. One
   surface per commit; the commit links its screenshot.
7. **Endpoints render only from the live signed quote** — never the
   offering-KA literal, anywhere in the DOM.
8. **Logos:** local license-checked assets in `assets/model-logos/` with
   `.logo-monogram` fallback. Never hotlink; never lift pixels from `refs/`.
9. **Screenshots in reports are real running UI with real data.** Mockups are
   labeled mockups. Stale status tables are defects — re-stamp on change.
10. **Unverifiable ≠ pass, on screen too:** a row whose quote fails
    verification renders as unverifiable and cannot be acted on.
