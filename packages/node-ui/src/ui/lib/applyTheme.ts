/**
 * Publishes the active theme on `<html>` and toggles the `light` class
 * on BOTH `<html>` (documentElement) and `<body>`. The `<html>`-level
 * class toggle is what BUG-004 fixed: `:root`
 * defines `--bg-root: #000000`, and the `html, body, #root { background:
 * var(--bg-root) }` rule applies that variable to `<html>` first. Putting
 * the override class on `<body>` alone re-cascaded the variable to the
 * body but `<html>` kept the dark colour, so macOS rubber-band overscroll
 * flashed a black strip in light mode. We keep `body.light` as well so
 * pre-rc.11 selectors (`body.light .v10-modal-box`, etc.) still apply.
 *
 * The explicit `data-theme` marker is also the integration boundary for
 * auto-themed child components. Dark mode used to be represented only by
 * the absence of `.light`, which made those components fall back to the OS
 * preference instead of the app's saved theme.
 *
 * Pulling the update into a pure helper lets a unit test pin both contracts:
 * the CSS class stays synchronized across `<html>` / `<body>`, and the root
 * always exposes the selected theme to descendants.
 */
export function applyTheme(theme: 'light' | 'dark', doc: Document = document): void {
  const isLight = theme === 'light';
  doc.documentElement.setAttribute('data-theme', theme);
  doc.documentElement.classList.toggle('light', isLight);
  doc.body.classList.toggle('light', isLight);
}
