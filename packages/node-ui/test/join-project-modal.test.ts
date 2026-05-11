import { describe, it, expect } from 'vitest';
import { parseInviteCode, validateInvite } from '../src/ui/components/Modals/JoinProjectModal.js';

describe('JoinProjectModal invite parsing', () => {
  describe('V10 peer-id invites', () => {
    it('parses two-line cgId + peerId invite', () => {
      const raw = ['my-project', '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6'].join('\n');
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('my-project');
      expect(parsed.curatorPeerId).toBe('12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.legacyMultiaddr).toBeNull();
    });

    it('parses peer-id invite with surrounding whitespace', () => {
      const raw = '\n  my-project  \n  12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6  \n';
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('my-project');
      expect(parsed.curatorPeerId).toBe('12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.legacyMultiaddr).toBeNull();
    });

    it('treats invite with only a cgId as valid (cg public, no curator dial)', () => {
      const parsed = parseInviteCode('open-project');
      expect(parsed.cgId).toBe('open-project');
      expect(parsed.curatorPeerId).toBeNull();
      expect(parsed.legacyMultiaddr).toBeNull();
      expect(parsed.hasUnparsedExtra).toBe(false);
      expect(validateInvite(parsed)).toBeNull();
    });

    it('validates a peer-id invite as ok', () => {
      const parsed = parseInviteCode('my-project\n12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.hasUnparsedExtra).toBe(false);
      expect(validateInvite(parsed)).toBeNull();
    });

    // Regression for Codex review on PR #431 (Issue 3): a typo'd peer id
    // on the second line used to be silently dropped, so the user fell
    // into the bare-cgId flow without an immediate input error.
    it('rejects invite whose second line is neither a peer id nor a multiaddr', () => {
      const parsed = parseInviteCode('my-project\n12D3KooBAD');
      expect(parsed.cgId).toBe('my-project');
      expect(parsed.curatorPeerId).toBeNull();
      expect(parsed.legacyMultiaddr).toBeNull();
      expect(parsed.hasUnparsedExtra).toBe(true);
      const err = validateInvite(parsed);
      expect(err).not.toBeNull();
      expect(err).toContain('not a valid peer ID');
    });

    it('rejects invite with garbage trailing content', () => {
      const parsed = parseInviteCode('my-project\nthis is just some random text');
      expect(parsed.hasUnparsedExtra).toBe(true);
      expect(validateInvite(parsed)).not.toBeNull();
    });
  });

  describe('legacy multiaddr invites (deprecated)', () => {
    it('parses multiline invite codes with wrapped multiaddr', () => {
      const raw = [
        '0xabc/project',
        '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-',
        'circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      ].join('\n');

      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('0xabc/project');
      expect(parsed.legacyMultiaddr).toBe('/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.curatorPeerId).toBeNull();
    });

    it('parses single-line invite codes with inline multiaddr', () => {
      const raw = '0xabc/project /ip4/127.0.0.1/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('0xabc/project');
      expect(parsed.legacyMultiaddr).toBe('/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(parsed.curatorPeerId).toBeNull();
    });

    // Codex review on PR #431 (round 2): V9 `<cgId> @ <multiaddr>` form
    // was leaving the `@` glued to the cgId (`"my-project @"`).
    it('parses V9 single-line `<cgId> @ <multiaddr>` form, stripping the `@` separator', () => {
      const raw = 'my-project @ /ip4/1.2.3.4/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('my-project');
      expect(parsed.legacyMultiaddr).toBe('/ip4/1.2.3.4/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(parsed.hasUnparsedExtra).toBe(false);
      expect(validateInvite(parsed)).toBeNull();
    });

    // Codex review on PR #431 (round 2): inline multiaddr regex was missing
    // /dnsaddr/, so DNS-based legacy invites collapsed into the cgId line.
    it('recognizes /dnsaddr/ multiaddrs (was dropped by the old regex)', () => {
      const raw = 'my-project /dnsaddr/relay.example.com/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('my-project');
      expect(parsed.legacyMultiaddr).toBe('/dnsaddr/relay.example.com/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(parsed.hasUnparsedExtra).toBe(false);
    });

    it('recognizes /dns4/ multiaddrs in two-line form', () => {
      const raw = 'my-project\n/dns4/relay.example.com/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('my-project');
      expect(parsed.legacyMultiaddr).toBe('/dns4/relay.example.com/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    });

    it('validates missing peer id in multiaddr', () => {
      const parsed = parseInviteCode('0xabc/project\n/ip4/127.0.0.1/tcp/9090');
      expect(validateInvite(parsed)).toBe('Curator multiaddr is missing peer ID');
    });

    it('validates missing project id', () => {
      const parsed = parseInviteCode('');
      expect(validateInvite(parsed)).toBe('Missing project ID');
    });
  });
});
