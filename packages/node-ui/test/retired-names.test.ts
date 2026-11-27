// A retired class or token goes in the PR that replaces it (DESIGN.md · Changing
// the system). This finds what such a PR left behind: stylesheet classes no
// markup uses, tokens nothing reads, and e2e selectors for classes that no longer
// exist. e2e doesn't run with the normal suite, so a stale selector stays hidden
// until someone runs it.
//
// It reads names, not behaviour: a name that only survives in a comment counts
// as used, and any class under a family built at runtime (`ds-tone-${tone}`)
// counts as used.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, cssFiles, read, uiFiles, walk, withoutCssComments as withoutComments } from './helpers/source.js';

const css = cssFiles.map((f) => withoutComments(read(f)));
const code = uiFiles.filter((f) => /\.(tsx?|html)$/.test(f)).map(read).join('\n');
const codeWords = new Set(code.match(/[a-zA-Z_][\w-]*/g));

/** Literal start of a class built at runtime. `ds-${variant}` is too broad to count: it would cover the whole system. */
export const runtimeFamilies = (source: string) => [...new Set([...source.matchAll(/([a-zA-Z][\w-]*-)\$\{/g)].map((m) => m[1]!))].filter((p) => p !== 'ds-');
const families = runtimeFamilies(code);
const isBuiltAtRuntime = (name: string) => families.some((family) => name.startsWith(family));

/** Class names in the selectors of a stylesheet. */
export function selectorClasses(source: string): string[] {
  return [...source.matchAll(/([^{}]+)\{/g)]
    .filter((m) => !m[1]!.trim().startsWith('@'))
    .flatMap((m) => [...m[1]!.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((c) => c[1]!));
}

/** Names `DESIGN.md · Names kept for now` lists, each with its reason. */
const section = /### Names kept for now\r?\n([\s\S]*?)(?=\r?\n##)/.exec(read(join(ROOT, 'DESIGN.md')))?.[1] ?? '';
const kept = new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/^\./, '')));

// Classes added to the page by Lucide, not by this package.
const THIRD_PARTY = /^lucide(-|$)/;

describe('retired names', () => {
  it('reads classes and runtime families', () => {
    expect(selectorClasses('.a:hover .b, .c > d { color: red; } @media (min-width: 1.5px) { .e { top: 0; } }')).toEqual(['a', 'b', 'c', 'e']);
    expect(runtimeFamilies('className={`ds-tone-${t} ds-${v}`}')).toEqual(['ds-tone-']);
  });

  it('every stylesheet class is used somewhere', () => {
    const unused = [...new Set(css.flatMap(selectorClasses))]
      .filter((name) => !codeWords.has(name) && !isBuiltAtRuntime(name) && !THIRD_PARTY.test(name) && !kept.has(name));
    expect(unused).toEqual([]);
  });

  it('every token is read somewhere', () => {
    const theme = withoutComments(read('styles/00-theme.css'));
    const tokens = [...new Set([...theme.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!))];
    const readers = css.join('\n').replace(/--[a-z0-9-]+\s*:/g, '') + code;
    const isRead = (token: string) => new RegExp(`${token}(?![\\w-])`).test(readers);
    const tokenFamilies = [...new Set([...code.matchAll(/(--[a-z][\w-]*-)\$\{/g)].map((m) => m[1]!))];
    expect(tokens.filter((t) => !isRead(t) && !tokenFamilies.some((f) => t.startsWith(f)) && !kept.has(t))).toEqual([]);
  });

  it('e2e selects only classes that still exist', () => {
    const everything = new Set(`${code}\n${css.join('\n')}`.match(/[a-zA-Z_][\w-]*/g));
    const missing = walk(join(ROOT, 'e2e')).filter((f) => f.endsWith('.ts')).flatMap((file) => (
      [...read(file).replace(/^\s*\/\/.*$/gm, '').matchAll(/\.((?:v10|ds)-[\w-]*\w)(?![\w$-])/g)].map((m) => m[1]!)
    )).filter((name) => !everything.has(name) && !isBuiltAtRuntime(name));
    expect([...new Set(missing)]).toEqual([]);
  });
});
