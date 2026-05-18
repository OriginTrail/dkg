import { describe, it, expect } from 'vitest';
import {
  parseInviteCode,
  validateInvite,
  formatJoinRequestError,
} from '../src/ui/components/Modals/JoinProjectModal.js';
import { HttpError } from '../src/ui/api.js';

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

    // PR #448 review: V10 `/request-join` requires a curator peer id, so
    // a bare cgId now 400s on the daemon. validateInvite rejects it
    // client-side instead, with actionable copy. The old subscribe-to-public
    // paste flow has been removed; users who want a public CG that
    // hasn't surfaced in the Oracle have to ask the curator for an invite.
    it('rejects invite with only a cgId (no curator peer id)', () => {
      const parsed = parseInviteCode('open-project');
      expect(parsed.cgId).toBe('open-project');
      expect(parsed.curatorPeerId).toBeNull();
      expect(parsed.legacyMultiaddr).toBeNull();
      expect(parsed.hasUnparsedExtra).toBe(false);
      const err = validateInvite(parsed);
      expect(err).not.toBeNull();
      expect(err).toContain('curator peer id');
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
      // PR #448 review (round 4): the parser now also extracts the
      // peer-id at the multiaddr's `/p2p/<id>` tail so legacy invites
      // can satisfy V10's mandatory `curatorPeerId` on /request-join.
      // Without this the curated-project legacy path 400'd at sign time.
      expect(parsed.curatorPeerId).toBe('12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
    });

    it('parses single-line invite codes with inline multiaddr', () => {
      const raw = '0xabc/project /ip4/127.0.0.1/tcp/9090/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
      const parsed = parseInviteCode(raw);
      expect(parsed.cgId).toBe('0xabc/project');
      expect(parsed.legacyMultiaddr).toBe('/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
      expect(parsed.curatorPeerId).toBe('12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
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
      expect(validateInvite(parsed)).toBe('Missing context graph ID');
    });
  });
});

describe('formatJoinRequestError', () => {
  // The daemon's 502 body for /request-join is
  //   { error: <headline>, errors?: string[] }
  // when `forwardJoinRequest` couldn't deliver. errors[] carries
  // per-peer reasons; the helper has to render them, not drop them.
  // (See packages/cli/src/daemon/routes/context-graph.ts → the
  // `request-join` branch, and packages/agent/src/dkg-agent.ts →
  // `forwardJoinRequest`.)

  it('surfaces a curator scope-mismatch rejection with an actionable hint', () => {
    // This is the exact failure mode that prompted this PR — the
    // joiner's daemon was signing delegations against the old
    // pre-redeploy testnet hub, so the curator rejected every signed
    // delegation with `scope mismatch` and the UI hid the reason behind
    // a generic "no reachable curator" string.
    const err = new HttpError(502, 'Could not deliver join request to curator. No reachable curator found.', {
      error: 'Could not deliver join request to curator. No reachable curator found.',
      errors: [
        'kmTfyjRK: verifyAgentDelegation: scope mismatch ' +
          '(expected "sync:deployment=base:84532:hub=0xc056e67da4f51377ad1b01f50f655ffdccd809f6:0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E/rc7-test", ' +
          'got "sync:deployment=base:84532:hub=0xf21ce8f8b01548d97dcfb36869f1ccb0814a4e05:0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E/rc7-test")',
      ],
    });

    const msg = formatJoinRequestError(err);

    expect(msg).toContain('Curator rejected this join request');
    expect(msg).toContain('scope mismatch');
    expect(msg).toContain('ContextGraphsHub address');
  });

  it('surfaces an unknown-CG rejection with an actionable hint', () => {
    const err = new HttpError(502, 'no reachable curator', {
      error: 'Could not deliver join request to curator. No reachable curator found.',
      errors: ['kmTfyjRK: unknown CG'],
    });

    const msg = formatJoinRequestError(err);

    expect(msg).toContain('unknown CG');
    expect(msg).toContain('double-check the invite');
  });

  it('keeps the no-reachable-curator copy when errors[] is empty (transport failure, no per-peer detail)', () => {
    // No `errors[]` in the body means `forwardJoinRequest` had nothing
    // to record per peer (every dial failed silently / older daemon).
    // The legacy copy is still the right thing to show here.
    const err = new HttpError(502, 'no reachable curator', {
      error: 'Could not deliver join request to curator. No reachable curator found.',
    });

    const msg = formatJoinRequestError(err);

    expect(msg).toContain("couldn't deliver");
    expect(msg).toContain('discovered more peers');
  });

  it('distinguishes dial-failed errors from rejections in the headline', () => {
    // All entries are `dial failed` ⇒ the peer was never reached; the
    // headline should be the transport-flavoured one, not the
    // curator-rejected one.
    const err = new HttpError(502, 'no reachable curator', {
      error: 'Could not deliver join request to curator. No reachable curator found.',
      errors: ['kmTfyjRK: dial failed (timeout after 10000ms)'],
    });

    const msg = formatJoinRequestError(err);

    expect(msg).toContain("Couldn't deliver");
    expect(msg).not.toContain('Curator rejected');
    expect(msg).toContain('dial failed');
  });

  // Codex review on PR #508 round 1 caught a misdiagnosis: when the
  // targeted curator dial times out, `forwardJoinRequest` falls through
  // to the broadcast cohort. Non-curator peers in that cohort respond
  // `not curator` and get appended to `errors[]` alongside the
  // earlier `dial failed (timeout)` line. The original
  // "any entry that isn't dial-failed ⇒ rejection" heuristic flipped
  // the headline to "Curator rejected this join request" for this
  // mix, even though the curator was never reached. Pin the corrected
  // semantic: `dial failed` + `not curator` (the only two
  // delivery-failure signals from forwardJoinRequest) must still read
  // as a delivery failure.
  it('treats targeted-dial-failed + non-curator-broadcast as a delivery failure (Codex #508 round 1)', () => {
    const err = new HttpError(502, 'no reachable curator', {
      error: 'Could not deliver join request to curator. No reachable curator found.',
      errors: [
        'kmTfyjRK: dial failed (timeout after 10000ms)',
        'cAbCdEfG: not curator',
        'hIjKlMnO: not curator',
      ],
    });

    const msg = formatJoinRequestError(err);

    expect(msg).toContain("Couldn't deliver");
    expect(msg).not.toContain('Curator rejected');
    expect(msg).toContain('dial failed');
    expect(msg).toContain('not curator');
    expect(msg).toContain('none of them curate this context graph');
  });

  it('treats broadcast-only `not curator` (no targeted curator reached) as a delivery failure', () => {
    // If every broadcast peer answered `not curator` and there is no
    // `dial failed` entry (e.g. legacy multiaddr invite path with no
    // targeted curator step), it's still a delivery failure, not a
    // rejection.
    const err = new HttpError(502, 'no reachable curator', {
      error: 'Could not deliver join request to curator. No reachable curator found.',
      errors: ['cAbCdEfG: not curator', 'hIjKlMnO: not curator'],
    });

    const msg = formatJoinRequestError(err);

    expect(msg).toContain("Couldn't deliver");
    expect(msg).not.toContain('Curator rejected');
    expect(msg).toContain('none of them curate this context graph');
  });

  it('falls back to err.message for non-502 errors', () => {
    const err = new HttpError(400, 'Missing curatorPeerId', { error: 'Missing curatorPeerId' });
    expect(formatJoinRequestError(err)).toBe('Missing curatorPeerId');
  });

  it('falls back to a generic message when err is not an Error at all', () => {
    expect(formatJoinRequestError(undefined)).toBe('Failed to send join request');
    expect(formatJoinRequestError('boom')).toBe('Failed to send join request');
  });
});
