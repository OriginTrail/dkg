// One look per feedback state (see DESIGN.md): the rules that can be read from
// the code.
import { describe, expect, it } from 'vitest';
import { cssFiles, findAll, read, tsxFiles, withoutCssComments } from './helpers/source.js';

const matches = (pattern: RegExp) => findAll(tsxFiles, pattern, { show: (m) => m[0].slice(0, 80) });

describe('feedback states', () => {
  it('ends loading copy with an ellipsis, not three dots', () => {
    expect(matches(/Loading [^'"`<\n]*\.\.\./g)).toEqual([]);
  });

  it('uses EmptyState, not the older markup', () => {
    expect(matches(/className="empty-state/g)).toEqual([]);
  });

  it('gives fields the same disabled look as buttons, and a red border when invalid', () => {
    expect(read('styles/01-base.css')).toMatch(/button:disabled, input:disabled, textarea:disabled, select:disabled \{ opacity: var\(--opacity-disabled\)/);
    expect(read('styles/27-ds-components.css')).toMatch(/\.ds-input\[aria-invalid="true"\]:not\(\[role="combobox"\]\) \{ border-color: var\(--accent-red\)/);
  });

  it('shows every disabled control the same way', () => {
    const found = findAll(cssFiles, /([^{}]*:disabled[^{}]*)\{([^{}]*)\}/g, {
      prepare: withoutCssComments,
      keep: ([, selector, body]) => !selector!.includes(':not(:disabled)') && /opacity:\s*[\d.]/.test(body!),
      show: ([, selector]) => selector!.trim(),
    });
    expect(found).toEqual([]);
  });

  it('announces form errors', () => {
    expect(matches(/<div className="v10-modal-error[^>]*>/g).filter((m) => !m.includes('role='))).toEqual([]);
  });
});
