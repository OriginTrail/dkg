// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme } from '../src/ui/lib/applyTheme.js';

/**
 * BUG-004 regression guard. The fix migrated the `light` class from
 * `<body>` to BOTH `<html>` (documentElement) and `<body>`, because
 * `:root` defines `--bg-root: #000000` and the `html` element rendered
 * the dark colour first; macOS rubber-band overscroll then flashed a
 * black strip on light-mode pages. The contract is:
 *
 *   - light  → both <html> AND <body> carry the `light` class
 *   - dark   → neither element carries the `light` class
 *   - toggling back to dark must remove the class from BOTH (no orphan
 *     class on `<html>` after a dark→light→dark cycle)
 *   - `<html>` always carries `data-theme="light|dark"` so auto-themed
 *     descendants follow the app setting instead of the OS preference
 */
describe('applyTheme (BUG-004)', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('light');
    document.body.classList.remove('light');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    document.documentElement.classList.remove('light');
    document.body.classList.remove('light');
    document.documentElement.removeAttribute('data-theme');
  });

  it('light: adds .light to BOTH documentElement AND body', () => {
    applyTheme('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.body.classList.contains('light')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('dark: keeps the clean no-.light baseline and publishes an explicit root marker', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.body.classList.contains('light')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('dark→light→dark: cleanly removes the class from documentElement (the BUG-004 reproducer)', () => {
    applyTheme('dark');
    applyTheme('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    applyTheme('dark');
    // Pre-fix this assertion failed: documentElement was never managed,
    // so the rubber-band area kept a stale background colour.
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.body.classList.contains('light')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('idempotent: applying the same theme twice does not stack duplicate tokens', () => {
    applyTheme('light');
    applyTheme('light');
    // classList is a token list — duplicates are illegal anyway, but
    // pin the count to catch any future re-implementation that uses
    // `classList.add` without checks against a custom string.
    expect(document.documentElement.className.split(/\s+/).filter((c) => c === 'light').length).toBe(1);
    expect(document.body.className.split(/\s+/).filter((c) => c === 'light').length).toBe(1);
  });

  it('preserves unrelated classes on documentElement / body (additive toggle, not class replacement)', () => {
    document.documentElement.classList.add('has-touch');
    document.body.classList.add('cursor-default');
    applyTheme('light');
    expect(document.documentElement.classList.contains('has-touch')).toBe(true);
    expect(document.body.classList.contains('cursor-default')).toBe(true);
    applyTheme('dark');
    expect(document.documentElement.classList.contains('has-touch')).toBe(true);
    expect(document.body.classList.contains('cursor-default')).toBe(true);
  });

  it('accepts an injected Document so server-side / iframe consumers can theme a different doc', () => {
    // applyTheme defaults to the global `document`, but the helper
    // takes an optional second arg so tests / iframe hosts can theme
    // a different document tree without monkey-patching globals.
    const fakeHtml = document.createElement('html');
    const fakeBody = document.createElement('body');
    const fakeDoc = {
      documentElement: fakeHtml,
      body: fakeBody,
    } as unknown as Document;

    applyTheme('light', fakeDoc);
    expect(fakeHtml.classList.contains('light')).toBe(true);
    expect(fakeBody.classList.contains('light')).toBe(true);
    expect(fakeHtml.getAttribute('data-theme')).toBe('light');
    // The real document must NOT have been touched.
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.body.classList.contains('light')).toBe(false);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
