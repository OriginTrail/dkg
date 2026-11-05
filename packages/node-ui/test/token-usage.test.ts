// Token usage. A var() naming a token nothing defines is invalid at paint
// time, so the element silently loses that colour or surface. And signal
// fills (--accent-red and friends) are for marks, not text: they don't clear
// 4.5:1 in light mode, which is what --text-danger and friends are for.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(__dirname, '../src/ui');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const cssFiles = files(UI, /\.css$/);
const codeFiles = files(UI, /\.tsx?$/);
const css = cssFiles.map((f) => withoutComments(readFileSync(f, 'utf-8'))).join('\n');
const code = codeFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');

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
      .filter((f) => fillAsText.test(withoutComments(readFileSync(f, 'utf-8'))))
      .map((f) => f.slice(UI.length + 1));
    expect(offenders).toEqual([]);
  });

  it('blue stays off links, focus and tints: only the role tokens carry it', () => {
    const uses = cssFiles
      .filter((f) => !f.endsWith('00-theme.css'))
      .filter((f) => /var\(--accent-blue/.test(withoutComments(readFileSync(f, 'utf-8'))))
      .map((f) => f.slice(UI.length + 1));
    expect(uses).toEqual([]);
  });
});
