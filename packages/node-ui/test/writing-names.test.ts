// Edge and Core name the role a node performs, so they keep their capitals in
// anything a person reads (DESIGN.md · Type). Comments and role values in code are fine.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Lower-case role names in running text: "edge node", "core-first", a raw `{role}` after "Node role:". */
export const lowerCaseRoles = (source: string) => [
  ...source.matchAll(/\b(?:edge|core) nodes?\b|[>'"`\s]core-first\b|Node role: \{role\}/g),
].map((m) => m[0].trim());

describe('Edge and Core', () => {
  it('finds lower-case role names', () => {
    expect(lowerCaseRoles('<p>The edge node shares</p>')).toEqual(['edge node']);
    expect(lowerCaseRoles('<div>core-first pulls</div>')).toEqual(['>core-first']);
    expect(lowerCaseRoles('<p>The Edge node</p>')).toEqual([]);
  });

  it('are capitalised in UI text', () => {
    const files = walk(resolve(__dirname, '../src/ui')).filter((f) => f.endsWith('.tsx'));
    const found = files.flatMap((f) => lowerCaseRoles(withoutComments(readFileSync(f, 'utf8'))).map((hit) => `${f}: ${hit}`));
    expect(found).toEqual([]);
  });
});
