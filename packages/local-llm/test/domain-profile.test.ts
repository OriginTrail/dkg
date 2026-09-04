import { describe, expect, it } from 'vitest';
import { parseDomainProfile } from '../src/domain-profile.js';

describe('domain profile contract', () => {
  it('normalizes a partner profile without domain-specific core code', () => {
    expect(parseDomainProfile({
      name: 'supply-chain',
      routingKeywords: ['configuration', 'BOM', 'configuration'],
      readTools: ['partner_trace', 'partner_trace'],
      writeTools: ['partner_insert'],
      systemContext: 'Use exact identifiers from tool evidence.',
    })).toEqual({
      name: 'supply-chain',
      routingKeywords: ['configuration', 'BOM'],
      readTools: ['partner_trace'],
      writeTools: ['partner_insert'],
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
