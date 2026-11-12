// Token usage. A var() naming a token nothing defines is invalid at paint
// time, so the element silently loses that colour or surface. And signal
// fills (--accent-red and friends) are for marks, not text: they don't clear
// 4.5:1 in light mode, which is what --text-danger and friends are for.
import { describe, expect, it } from 'vitest';
import { codeFiles, cssFiles, read, where, withoutCssComments as withoutComments } from './helpers/source.js';

const css = cssFiles.map((f) => withoutComments(read(f))).join('\n');
const code = codeFiles.map((f) => read(f)).join('\n');

describe('token usage', () => {
  it('every token used is defined in a stylesheet or set from code', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const setFromCode = new Set([...code.matchAll(/['"`](--[\w-]+)['"`]/g)].map((m) => m[1]));
    const used = new Set([...(css + code).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    // `--data-${n}` style names are built at runtime; their literal part ends in a dash.
    const missing = [...used].filter((t) => !t.endsWith('-') && !defined.has(t) && !setFromCode.has(t));
    expect(missing).toEqual([]);
  });

  it('text uses --text-* signal tokens, not the signal fills', () => {
    const fillAsText = /(?<![-\w])color:\s*'?var\(--(?:accent-(?:red|green|amber)|red|green|amber)\)/;
    const offenders = [...cssFiles, ...codeFiles]
      .filter((f) => !f.endsWith('00-theme.css'))
      .filter((f) => fillAsText.test(withoutComments(read(f))))
      .map(where);
    expect(offenders).toEqual([]);
  });

  it('card padding comes from the padding tokens, never a number', () => {
    const inline = /className="[^"]*\bds-card\b[^"]*" style=\{\{ padding: (?!0\b|'var\(--pad-)/;
    const offenders = codeFiles.filter((f) => inline.test(read(f))).map(where);
    expect(offenders).toEqual([]);
  });
});
