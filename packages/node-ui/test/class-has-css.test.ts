// A class in markup needs a rule. Retiring a stylesheet family while markup
// still uses it leaves those elements silently unstyled, and nothing else
// fails: this is how the legacy `.badge` rules were removed while 22 elements
// still used them. Screen classes (`v10-*`) are often plain hooks for tests
// and layout, so this checks the short shared names, where a missing rule
// means lost styling.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(__dirname, '../src/ui');

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return name.endsWith(ext) ? [path] : [];
  });
}

/** Class tokens written literally in a file's className attributes. */
export function classTokens(source: string): string[] {
  const attrs = [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
  return attrs.flatMap((attr) => attr.replace(/\$\{[^}]*\}/g, '\u0000').split(/\s+/)).filter((t) => /^[a-zA-Z][\w-]*$/.test(t));
}

/** Prefixed classes are owned elsewhere: `ds-*` by ds-classes.test.ts, `v10-*` and `dsp-*` by their screens. */
const isShared = (token: string) => !/^(v10|ds|dsp)(-|$)/.test(token);

// Allowed without a rule: `secondary`, an e2e selector hook. Shrink this, never grow it.
const KNOWN_GAPS = new Set(['secondary']);

describe('classes in markup', () => {
  const css = files(UI, '.css').map((f) => readFileSync(f, 'utf-8')).join('\n');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));

  it('finds literal and template class tokens', () => {
    expect(classTokens('<a className="badge badge-info" />')).toEqual(['badge', 'badge-info']);
    expect(classTokens('<a className={`badge ${x ? "y" : "z"} mono`} />')).toEqual(['badge', 'mono']);
    // A class built at runtime can't be checked: its literal part is not a class.
    expect(classTokens('<a className={`tone-${x} mono`} />')).toEqual(['mono']);
  });

  it('every shared class has a stylesheet rule', () => {
    const missing = new Map<string, string>();
    for (const file of files(UI, '.tsx')) {
      for (const token of classTokens(readFileSync(file, 'utf-8'))) {
        if (isShared(token) && !defined.has(token) && !KNOWN_GAPS.has(token)) missing.set(token, file.slice(UI.length + 1));
      }
    }
    expect([...missing.entries()]).toEqual([]);
  });

  it('the retired badge family stays gone: use the Badge component', () => {
    for (const file of files(UI, '.tsx')) {
      const tokens = classTokens(readFileSync(file, 'utf-8'));
      expect(tokens.filter((t) => /^badge(-|$)/.test(t)), file).toEqual([]);
    }
  });
});
