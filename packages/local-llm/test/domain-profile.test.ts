import { describe, expect, it } from 'vitest';
import { parseDomainProfile } from '../src/domain-profile.js';

describe('domain profile contract', () => {
  it('normalizes a partner profile without domain-specific core code', () => {
    expect(parseDomainProfile({
      name: 'supply-chain',
      routingKeywords: ['configuration', 'BOM', 'configuration'],
      readTools: ['partner_trace', 'partner_trace'],
      writeTools: ['partner_insert'],
      requiredTools: ['partner_trace', 'partner_trace'],
      systemContext: 'Use exact identifiers from tool evidence.',
    })).toEqual({
      name: 'supply-chain',
      routingKeywords: ['configuration', 'BOM'],
      readTools: ['partner_trace'],
      writeTools: ['partner_insert'],
      requiredTools: ['partner_trace'],
      systemContext: 'Use exact identifiers from tool evidence.',
    });
  });

  it('rejects missing routing/tool lists and malformed tool names', () => {
    expect(() => parseDomainProfile({ name: 'empty' })).toThrow('routingKeywords');
    expect(() => parseDomainProfile({
      name: 'bad',
      routingKeywords: ['configuration'],
      readTools: ['not a tool'],
    })).toThrow('invalid MCP tool name');
  });
});

describe('domain profile validation boundaries', () => {
  const valid = { name: 'partner', routingKeywords: ['orders'], readTools: ['partner.read'] };

  it.each([null, [], 'partner', false, 42])('rejects a non-object profile %j', value => {
    expect(() => parseDomainProfile(value)).toThrow('Domain profile must be a JSON object.');
  });

  it.each(['name', 'description', 'systemContext'])('rejects an empty %s', key => {
    expect(() => parseDomainProfile({ ...valid, [key]: '  ' })).toThrow(`'${key}' must be a non-empty string`);
  });

  it.each(['routingKeywords', 'readTools', 'writeTools', 'requiredTools'] as const)
    ('enforces list type, count, and item limits for %s', key => {
      expect(() => parseDomainProfile({ ...valid, [key]: 'not-a-list' })).toThrow(`'${key}' must be a`);
      expect(() => parseDomainProfile({ ...valid, [key]: Array(65).fill('valid') })).toThrow('at most 64 entries');
      expect(() => parseDomainProfile({ ...valid, [key]: [' '] })).toThrow('only non-empty strings');
      expect(() => parseDomainProfile({ ...valid, [key]: [42] })).toThrow('only non-empty strings');
      expect(() => parseDomainProfile({ ...valid, [key]: ['x'.repeat(129)] })).toThrow('at most 128 characters');
      expect(parseDomainProfile({ ...valid, [key]: ['x'.repeat(128)] })[key])
        .toEqual(['x'.repeat(128)]);
    });

  it('accepts exact maximums and trims and deduplicates lists without mutating caller input', () => {
    const input = { ...valid, description: '  partner tools  ', readTools: [' partner.read ', 'partner.read'],
      routingKeywords: Array.from({ length: 64 }, (_, i) => `word-${i}`), systemContext: 'x'.repeat(20_000) };
    const snapshot = structuredClone(input);
    expect(parseDomainProfile(input)).toEqual({ ...input, description: 'partner tools', readTools: ['partner.read'] });
    expect(input).toEqual(snapshot);
    expect(() => parseDomainProfile({ ...valid, systemContext: 'x'.repeat(20_001) })).toThrow('at most 20000 characters');
  });
});
