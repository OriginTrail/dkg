import { describe, expect, it } from 'vitest';
import {
  hasValidGraphScopedContent,
  isGraphPublishAccessPolicy,
  resolveGraphPublishAccess,
} from '../src/graph-publish-envelope.js';

describe('graph publish envelope predicates', () => {
  it.each([
    [1, 0, undefined, true], [0, 1, 32, true], [1, 1, 32, true],
    [0, 0, undefined, false], [-1, 0, undefined, false], [1, -1, undefined, false],
    [1.5, 0, undefined, false], [1, .5, 32, false],
    [NaN, 0, undefined, false], [1, Infinity, 32, false],
    [Number.MAX_SAFE_INTEGER + 1, 0, undefined, false],
    [0, 1, undefined, false], [0, 1, 31, false], [0, 1, 33, false],
    [1, 0, 32, false], [1, 0, 0, false],
  ] as const)('validates counts %s/%s and private-root bytes %s', (publicCount, privateCount, rootBytes, expected) => {
    expect(hasValidGraphScopedContent(publicCount, privateCount,
      rootBytes === undefined ? undefined : new Uint8Array(rootBytes))).toBe(expected);
  });

  it.each(['public', 'ownerOnly', 'allowList'])('accepts the exact policy %s', policy => {
    expect(isGraphPublishAccessPolicy(policy)).toBe(true);
  });
  it.each([undefined, '', 'Public', 'allowlist', 'private'])('rejects unknown policy %s', policy => {
    expect(isGraphPublishAccessPolicy(policy)).toBe(false);
  });

  it('owns canonical peer normalization without mutating the input', () => {
    const raw = Object.freeze([' peer-b ', 'peer-a']);
    expect(resolveGraphPublishAccess('allowList', raw)).toEqual({ accessPolicy: 'allowList', allowedPeers: ['peer-b', 'peer-a'] });
    expect(raw).toEqual([' peer-b ', 'peer-a']);
  });

  it('rejects duplicate, empty and blank peers', () => {
    for (const peers of [[], [''], [' '], ['peer-a', ' peer-a '], ['peer-a', ' ']]) {
      expect(resolveGraphPublishAccess('allowList', peers)).toBeUndefined();
    }
  });

  it('requires an empty peer list for other valid policies and rejects unknown policies', () => {
    for (const accessPolicy of ['public', 'ownerOnly'] as const) {
      expect(resolveGraphPublishAccess(accessPolicy, [])).toEqual({ accessPolicy, allowedPeers: [] });
      expect(resolveGraphPublishAccess(accessPolicy, ['peer-a'])).toBeUndefined();
    }
    for (const policy of [undefined, '', 'Public', 'private']) {
      expect(resolveGraphPublishAccess(policy, [])).toBeUndefined();
      expect(resolveGraphPublishAccess(policy, ['peer-a'])).toBeUndefined();
    }
  });
});
