// Edge and Core name the role a node performs, so they keep their capitals in
// anything a person reads (DESIGN.md · Type). Comments and role values in code are fine.
import { describe, expect, it } from 'vitest';
import { read, tsxFiles, where } from './helpers/source.js';

const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Wrongly cased role names in running text: "edge node", "Core Node", "core-first", a raw `{role}` after "Node role:". */
export const lowerCaseRoles = (source: string) => [
  ...source.matchAll(/\b(?:edge|core) nodes?\b|\b(?:Edge|Core) Nodes?\b|[>'"`\s]core-first\b|Node role: \{role\}|nodeRole \?\? /g),
].map((m) => m[0].trim());

describe('Edge and Core', () => {
  it('finds lower-case role names', () => {
    expect(lowerCaseRoles('<p>The edge node shares</p>')).toEqual(['edge node']);
    expect(lowerCaseRoles('<div>core-first pulls</div>')).toEqual(['>core-first']);
    expect(lowerCaseRoles('<p>The Edge node</p>')).toEqual([]);
    expect(lowerCaseRoles('<p>The Core Node</p>')).toEqual(['Core Node']);
    expect(lowerCaseRoles("<td>{a.nodeRole ?? '—'}</td>")).toEqual(['nodeRole ??']);
  });

  it('are capitalised in UI text', () => {
    const found = tsxFiles.flatMap((f) => lowerCaseRoles(withoutComments(read(f))).map((hit) => `${where(f)}: ${hit}`));
    expect(found).toEqual([]);
  });
});
