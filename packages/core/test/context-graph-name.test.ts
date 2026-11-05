import { describe, expect, it } from 'vitest';
import { selectContextGraphName, type ContextGraphName, type ContextGraphNamePolicy } from '../src/context-graph-name.js';

const hash = `0x${'a'.repeat(64)}`;
const cli: ContextGraphNamePolicy = { legacyHashSource: 'on-chain', knownNameIsAuthoritative: false, blankNameIsUnresolved: false };
const mcp: ContextGraphNamePolicy = { legacyHashSource: 'id', knownNameIsAuthoritative: true, blankNameIsUnresolved: true };
const cases: Array<{ label: string; row: ContextGraphName; cli: string | null; mcp: string | null }> = [
  { label: 'ordinary same-name graph', row: { id: 'team', name: 'team' }, cli: 'team', mcp: 'team' },
  { label: 'explicit known name', row: { id: 'team', name: 'team', nameKnown: true }, cli: 'team', mcp: 'team' },
  { label: 'explicit unknown name', row: { id: 'team', name: 'stale', nameKnown: false }, cli: null, mcp: null },
  { label: 'missing name', row: { id: 'team' }, cli: null, mcp: null },
  { label: 'blank name', row: { id: 'team', name: ' ' }, cli: ' ', mcp: null },
  { label: 'legacy hash ID without chain provenance', row: { id: hash, name: hash }, cli: hash, mcp: null },
  { label: 'legacy chain hash', row: { id: 'local', name: hash, onChain: { nameHash: hash } }, cli: null, mcp: hash },
  { label: 'known flag versus chain provenance', row: { id: hash, name: hash, nameKnown: true, onChain: { nameHash: hash } }, cli: null, mcp: hash },
  { label: 'case-insensitive name against canonical chain hash', row: { id: 'local', name: hash.toUpperCase(), onChain: { nameHash: hash } }, cli: null, mcp: hash.toUpperCase() },
  { label: 'noncanonical chain hash stays distinct', row: { id: 'local', name: hash, onChain: { nameHash: hash.toUpperCase() } }, cli: hash, mcp: hash },
  { label: 'hash name with different provenance', row: { id: 'local', name: hash, onChain: { nameHash: `0x${'b'.repeat(64)}` } }, cli: hash, mcp: hash },
];
describe('shared context graph name provenance', () => {
  it.each(cases)('$label preserves each surface compatibility policy', ({ row, cli: cliName, mcp: mcpName }) => {
    expect(selectContextGraphName(row, cli)).toBe(cliName);
    expect(selectContextGraphName(row, mcp)).toBe(mcpName);
  });
});
