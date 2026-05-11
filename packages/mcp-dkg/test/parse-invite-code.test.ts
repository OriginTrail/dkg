import { describe, it, expect } from 'vitest';
import { parseInviteCode } from '../src/cli/index.js';

// Pure unit test for the mcp-dkg CLI's invite parser. Mirrors the
// node-ui's join-project-modal.test.ts so the two parsers stay
// behaviourally aligned. Codex review on PR #431 (round 2) flagged that
// the mcp-dkg copy was missing the "reject malformed second line" check
// that the UI parser had — these tests are the regression fence.

describe('mcp-dkg parseInviteCode', () => {
  describe('V10 peer-id invites', () => {
    it('parses two-line cgId + peerId', () => {
      const parsed = parseInviteCode('my-project\n12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.contextGraphId).toBe('my-project');
      expect(parsed.curatorPeerId).toBe('12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.multiaddr).toBeNull();
    });

    it('parses bare cgId (open project, no curator dial needed)', () => {
      const parsed = parseInviteCode('open-project');
      expect(parsed.contextGraphId).toBe('open-project');
      expect(parsed.curatorPeerId).toBeNull();
      expect(parsed.multiaddr).toBeNull();
    });
  });

  describe('legacy multiaddr invites', () => {
    it('parses V9 single-line `<cgId> @ <multiaddr>` form', () => {
      const parsed = parseInviteCode('my-project @ /ip4/1.2.3.4/tcp/9090/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.contextGraphId).toBe('my-project');
      expect(parsed.multiaddr).toBe('/ip4/1.2.3.4/tcp/9090/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.curatorPeerId).toBeNull();
    });

    it('parses two-line cgId + multiaddr', () => {
      const parsed = parseInviteCode('my-project\n/ip4/1.2.3.4/tcp/9090/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.contextGraphId).toBe('my-project');
      expect(parsed.multiaddr).toBe('/ip4/1.2.3.4/tcp/9090/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
    });
  });

  // Codex review on PR #431 (round 2) regression. Old behaviour fell
  // through to `{ contextGraphId: trimmed }` when line 2 was unparseable,
  // so a typo'd peer ID like "my-project\n12D3KooBAD" subscribed to the
  // garbage cgId "my-project\n12D3KooBAD". Now throws.
  describe('rejects unparseable second line (was silent fallback)', () => {
    it('throws on typo-shortened peer id', () => {
      expect(() => parseInviteCode('my-project\n12D3KooBAD')).toThrow(/Invalid invite/i);
    });

    it('throws on plain garbage second line', () => {
      expect(() => parseInviteCode('my-project\nthis is not anything')).toThrow(/Invalid invite/i);
    });

    it('does NOT throw when only a cgId is present', () => {
      expect(() => parseInviteCode('open-project')).not.toThrow();
    });
  });
});
