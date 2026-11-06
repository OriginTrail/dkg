// A retired class or token goes in the PR that replaces it (DESIGN.md · Changing
// the system). This finds what such a PR left behind: stylesheet classes no
// markup uses, tokens nothing reads, and e2e selectors for classes that no longer
// exist. e2e doesn't run with the normal suite, so a stale selector stays hidden
// until someone runs it.
//
// It reads names, not behaviour: a name that only survives in a comment counts
// as used, and any class under a family built at runtime (`ds-tone-${tone}`)
// counts as used.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const UI = join(ROOT, 'src/ui');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const read = (file: string) => readFileSync(file, 'utf-8');
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const uiFiles = walk(UI);
const css = uiFiles.filter((f) => f.endsWith('.css')).map((f) => withoutComments(read(f)));
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

// e2e selectors whose markup went before this check. Already stale on main; shrink this, never grow it.
const STALE_E2E = new Set([
  'v10-agent-content', 'v10-collapse-btn', 'v10-dash-project-card', 'v10-dash-project-count', 'v10-dash-project-name',
  'v10-dash-section-link', 'v10-layer-preview', 'v10-me-entity', 'v10-me-graph-loading', 'v10-me-list-row', 'v10-op-row',
  'v10-oracle-placeholder', 'v10-ops-detail', 'v10-ops-drawer', 'v10-ops-row', 'v10-po-card', 'v10-project-name',
  'v10-project-overview', 'v10-project-view', 'v10-pv-header', 'v10-quick-action', 'v10-quick-action-icon', 'v10-recent-op',
  'v10-recent-op-status', 'v10-recent-op-type', 'v10-tree-chevron', 'v10-tree-integration-dot', 'v10-tree-layer-header',
  'v10-tree-section-badge',
]);

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
    const theme = withoutComments(read(join(UI, 'styles/00-theme.css')));
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
    )).filter((name) => !everything.has(name) && !isBuiltAtRuntime(name) && !STALE_E2E.has(name));
    expect([...new Set(missing)]).toEqual([]);
  });

  it('no stale e2e entry has come back to life', () => {
    const everything = new Set(`${code}\n${css.join('\n')}`.match(/[a-zA-Z_][\w-]*/g));
    expect([...STALE_E2E].filter((name) => everything.has(name))).toEqual([]);
  });
});
