import { describe, expect, it } from 'vitest';
import {
  hasValidGraphPublishContent,
  hasValidGraphPublishPeers,
  isGraphPublishAccessPolicy,
  normalizeGraphPublishPeers,
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
    expect(hasValidGraphPublishContent(publicCount, privateCount,
      rootBytes === undefined ? undefined : new Uint8Array(rootBytes))).toBe(expected);
  });

  it.each(['public', 'ownerOnly', 'allowList'])('accepts the exact policy %s', policy => {
    expect(isGraphPublishAccessPolicy(policy)).toBe(true);
  });
  it.each([undefined, '', 'Public', 'allowlist', 'private'])('rejects unknown policy %s', policy => {
    expect(isGraphPublishAccessPolicy(policy)).toBe(false);
  });

  it('normalizes in first-occurrence order without mutating input; duplicates and empties remain invalid', () => {
    const raw = Object.freeze([' peer-b ', 'peer-a', 'peer-b', ' ']);
    const peers = normalizeGraphPublishPeers(raw);
    expect(peers).toEqual(['peer-b', 'peer-a']);
    expect(raw).toEqual([' peer-b ', 'peer-a', 'peer-b', ' ']);
    expect(hasValidGraphPublishPeers('allowList', raw.length, peers)).toBe(false);
  });

  it('requires peers only for allowList and accepts harmless surrounding whitespace', () => {
    const peers = normalizeGraphPublishPeers([' peer-a ']);
    expect(hasValidGraphPublishPeers('allowList', 1, peers)).toBe(true);
    expect(hasValidGraphPublishPeers('allowList', 0, [])).toBe(false);
    for (const policy of ['public', 'ownerOnly'] as const) {
      expect(hasValidGraphPublishPeers(policy, 0, [])).toBe(true);
      expect(hasValidGraphPublishPeers(policy, 1, peers)).toBe(false);
    }
  });
});
