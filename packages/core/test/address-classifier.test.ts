import { describe, it, expect } from 'vitest';
import { isPublicLikeAddress, isLocalOrInternalHostname } from '../src/node.js';

// Twin of `packages/node-ui/test/share-project-modal.test.ts`. The two
// classifiers (`isPublicLikeAddress` here and `isMultiaddrRemotelyDialable`
// in node-ui) MUST stay behaviourally aligned — the daemon uses one to
// decide when to log "Node is remotely-dialable", and the ShareProjectModal
// uses the other to decide whether to enable the V10 peer-id invite.
// Codex review on PR #434 (round 1) flagged that adding a second copy
// without core-side tests guarantees future drift. These tests are the
// regression fence for the daemon-side copy; they intentionally mirror
// the cases in share-project-modal.test.ts. If you change one, change the
// other.

describe('isPublicLikeAddress (daemon-side dialability classifier)', () => {
  describe('public-looking — accepted', () => {
    it('accepts public IPv4 + tcp', () => {
      expect(isPublicLikeAddress('/ip4/178.156.252.147/tcp/9090/p2p/12D3Koo')).toBe(true);
    });
    it('accepts dns / dns4 / dnsaddr with a public-looking host', () => {
      expect(isPublicLikeAddress('/dns4/relay.example.com/tcp/443/p2p/12D3Koo')).toBe(true);
      expect(isPublicLikeAddress('/dnsaddr/relay.origintrail.network/p2p/12D3Koo')).toBe(true);
    });
    it('accepts global-unicast IPv6', () => {
      expect(isPublicLikeAddress('/ip6/2a01:4ff:f4:843b::1/tcp/9090/p2p/12D3Koo')).toBe(true);
    });
  });

  describe('not public — rejected', () => {
    it('rejects loopback IPv4', () => {
      expect(isPublicLikeAddress('/ip4/127.0.0.1/tcp/57550/p2p/12D3Koo')).toBe(false);
    });
    it('rejects RFC1918 ranges', () => {
      expect(isPublicLikeAddress('/ip4/10.0.0.5/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip4/172.16.0.1/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip4/172.31.255.255/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip4/192.168.0.171/tcp/57550/p2p/12D3Koo')).toBe(false);
    });
    it('rejects link-local + CGNAT', () => {
      expect(isPublicLikeAddress('/ip4/169.254.1.5/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip4/100.105.212.110/tcp/57550/p2p/12D3Koo')).toBe(false);
    });
    // Codex review on PR #434 (round 2) caught a real drift between this
    // and the UI copy: the old core parser only checked NaN, so an octet
    // like 999 would slip through and be classified as "public". The UI
    // copy already had the 0..255 range check. Mirrored test ensures the
    // core copy now matches.
    it('rejects out-of-range IPv4 octets (drift fence vs UI 0..255 check)', () => {
      expect(isPublicLikeAddress('/ip4/999.1.1.1/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip4/256.0.0.1/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip4/-1.2.3.4/tcp/9090/p2p/12D3Koo')).toBe(false);
    });
    it('rejects loopback + link-local + ULA IPv6', () => {
      expect(isPublicLikeAddress('/ip6/::1/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip6/fe80::1/tcp/9090/p2p/12D3Koo')).toBe(false);
      expect(isPublicLikeAddress('/ip6/fc00::1/tcp/9090/p2p/12D3Koo')).toBe(false);
    });

    // Codex review on PR #434 (round 1) flagged that the dns* path of the
    // daemon-side classifier was identical to the UI's, so the same
    // hostname rejections must hold here. Mirror of the UI cases.
    describe('rejects local/internal hostnames behind /dns*/ (matches UI)', () => {
      it('rejects literal localhost', () => {
        expect(isPublicLikeAddress('/dns/localhost/tcp/9090/p2p/12D3Koo')).toBe(false);
        expect(isPublicLikeAddress('/dns4/localhost/tcp/9090/p2p/12D3Koo')).toBe(false);
      });
      it('rejects mDNS .local', () => {
        expect(isPublicLikeAddress('/dns/raspberrypi.local/tcp/9090/p2p/12D3Koo')).toBe(false);
      });
      it('rejects RFC 6761 reserved TLDs', () => {
        expect(isPublicLikeAddress('/dns/foo.test/tcp/9090/p2p/12D3Koo')).toBe(false);
        expect(isPublicLikeAddress('/dns/host.example/tcp/9090/p2p/12D3Koo')).toBe(false);
        expect(isPublicLikeAddress('/dns/x.invalid/tcp/9090/p2p/12D3Koo')).toBe(false);
        expect(isPublicLikeAddress('/dns/y.localhost/tcp/9090/p2p/12D3Koo')).toBe(false);
      });
      it('rejects IP literals embedded in /dns*/', () => {
        expect(isPublicLikeAddress('/dns/127.0.0.1/tcp/9090/p2p/12D3Koo')).toBe(false);
      });
      it('rejects single-label hostnames (no dot)', () => {
        expect(isPublicLikeAddress('/dns/internal-relay/tcp/9090/p2p/12D3Koo')).toBe(false);
      });
    });
  });
});

describe('isLocalOrInternalHostname', () => {
  it('treats empty / non-string as local (defensive)', () => {
    expect(isLocalOrInternalHostname('')).toBe(true);
    expect(isLocalOrInternalHostname(undefined as unknown as string)).toBe(true);
  });
  it('treats public FQDNs as non-local', () => {
    expect(isLocalOrInternalHostname('relay.origintrail.network')).toBe(false);
    expect(isLocalOrInternalHostname('a.b.c.example.com')).toBe(false);
  });
});
