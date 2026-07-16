/**
 * Toggles the `light` class on BOTH `<html>` (documentElement) and
 * `<body>`. The `<html>`-level toggle is what BUG-004 fixed: `:root`
 * defines `--bg-root: #000000`, and the `html, body, #root { background:
 * var(--bg-root) }` rule applies that variable to `<html>` first. Putting
 * the override class on `<body>` alone re-cascaded the variable to the
 * body but `<html>` kept the dark colour, so macOS rubber-band overscroll
 * flashed a black strip in light mode. We keep `body.light` as well so
 * pre-rc.11 selectors (`body.light .v10-modal-box`, etc.) still apply.
 *
 * Pulling the toggle into a pure helper lets a unit test pin the
 * contract: a regression that drops the documentElement half — or starts
 * applying `.light` to one and `.dark` to the other — fails immediately.
 */
export function applyTheme(theme: 'light' | 'dark', doc: Document = document): void {
  const isLight = theme === 'light';
  doc.documentElement.classList.toggle('light', isLight);
  doc.body.classList.toggle('light', isLight);
}
