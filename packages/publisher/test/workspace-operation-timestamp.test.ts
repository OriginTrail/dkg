import { describe, expect, it } from 'vitest';
import { decodeWorkspaceOperationTimestamp, isResolverWorkspaceOperationTimestamp } from '../src/workspace-operation-timestamp.js';

describe('workspace operation timestamp semantics', () => {
  it.each(['2026-10-26T10:00:00.000Z', '"2026-10-26T10:00:00.000Z"',
    '" 2026-10-26T10:00:00.000Z "^^<http://www.w3.org/2001/XMLSchema#dateTime>'])(
    'decodes the same instant from %s', term => {
      const ms = decodeWorkspaceOperationTimestamp(term);
      expect(ms).toBe(Date.parse('2026-10-26T10:00:00.000Z'));
      expect(isResolverWorkspaceOperationTimestamp(ms)).toBe(true);
    });
  it('keeps date decoding separate from the resolver nonnegative-range policy', () => {
    const historical = decodeWorkspaceOperationTimestamp('"1960-01-01T00:00:00.000Z"');
    expect(Number.isFinite(historical)).toBe(true);
    expect(isResolverWorkspaceOperationTimestamp(historical)).toBe(false);
    expect(isResolverWorkspaceOperationTimestamp(decodeWorkspaceOperationTimestamp('"not-a-date"'))).toBe(false);
    expect(isResolverWorkspaceOperationTimestamp(0)).toBe(true);
  });
});
