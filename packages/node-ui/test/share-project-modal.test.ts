import { describe, it, expect } from 'vitest';
import { isMultiaddrRemotelyDialable } from '../src/ui/components/Modals/ShareProjectModal.js';

// Pure unit test for the invite-ready gate. The full ShareProjectModal
// renders against /api/status; here we only exercise the multiaddr
// classifier so it stays in sync with the ranges enumerated in
// `isMultiaddrRemotelyDialable`'s JSDoc as the heuristic gets revised.

describe('isMultiaddrRemotelyDialable', () => {
  describe('dialable', () => {
    it('accepts circuit-relay multiaddrs (NAT\'d edge node case)', () => {
      const addr = '/ip4/49.12.4.64/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ/p2p-circuit/p2p/12D3KooWEw3Xh7KuDwRDSuhbpTpA5PeN58gchyQqQ321YYeppmXj';
      expect(isMultiaddrRemotelyDialable(addr)).toBe(true);
    });
    it('accepts public IPv4 + tcp', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/178.156.252.147/tcp/9090/p2p/12D3Koo...')).toBe(true);
    });
    it('accepts dns / dns4 / dnsaddr with a public-looking host', () => {
      expect(isMultiaddrRemotelyDialable('/dns4/relay.example.com/tcp/443/p2p/12D3Koo...')).toBe(true);
      expect(isMultiaddrRemotelyDialable('/dnsaddr/relay.origintrail.network/p2p/12D3Koo...')).toBe(true);
    });
    it('accepts global-unicast IPv6', () => {
      expect(isMultiaddrRemotelyDialable('/ip6/2a01:4ff:f4:843b::1/tcp/9090/p2p/12D3Koo...')).toBe(true);
    });
  });

  describe('not dialable (the invite-ready gate refuses these)', () => {
    it('rejects loopback IPv4', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/127.0.0.1/tcp/57550/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects RFC1918 ranges', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/10.0.0.5/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/172.16.0.1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/172.31.255.255/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/192.168.0.171/tcp/57550/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects link-local + CGNAT', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/169.254.1.5/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/100.105.212.110/tcp/57550/p2p/12D3Koo...')).toBe(false);
    });
    // Mirror of the core test in `packages/core/test/address-classifier.test.ts`.
    // Codex flagged on PR #434 (round 2) that the core copy was accepting
    // out-of-range octets while this copy already rejected them — a real drift.
    it('rejects out-of-range IPv4 octets', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/999.1.1.1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/256.0.0.1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/-1.2.3.4/tcp/9090/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects loopback + link-local + ULA IPv6', () => {
      expect(isMultiaddrRemotelyDialable('/ip6/::1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip6/fe80::1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip6/fc00::1/tcp/9090/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects garbage / empty', () => {
      expect(isMultiaddrRemotelyDialable('')).toBe(false);
      expect(isMultiaddrRemotelyDialable('not-a-multiaddr')).toBe(false);
    });

    // Codex review on the post-merge diff of PR #431 (round 3) flagged
    // that the previous `dns*` path was a blanket-accept. Tighten the gate
    // so common local/internal hostnames don't slip through.
    describe('rejects local/internal hostnames behind /dns*/', () => {
      it('rejects literal localhost', () => {
        expect(isMultiaddrRemotelyDialable('/dns/localhost/tcp/9090/p2p/12D3Koo...')).toBe(false);
        expect(isMultiaddrRemotelyDialable('/dns4/localhost/tcp/9090/p2p/12D3Koo...')).toBe(false);
      });
      it('rejects mDNS .local', () => {
        expect(isMultiaddrRemotelyDialable('/dns/raspberrypi.local/tcp/9090/p2p/12D3Koo...')).toBe(false);
      });
      it('rejects RFC 6761 reserved TLDs (.test, .example, .invalid, .localhost)', () => {
        expect(isMultiaddrRemotelyDialable('/dns/foo.test/tcp/9090/p2p/12D3Koo...')).toBe(false);
        expect(isMultiaddrRemotelyDialable('/dns/host.example/tcp/9090/p2p/12D3Koo...')).toBe(false);
        expect(isMultiaddrRemotelyDialable('/dns/x.invalid/tcp/9090/p2p/12D3Koo...')).toBe(false);
        expect(isMultiaddrRemotelyDialable('/dns/y.localhost/tcp/9090/p2p/12D3Koo...')).toBe(false);
      });
      it('rejects IP literals embedded in /dns*/', () => {
        expect(isMultiaddrRemotelyDialable('/dns/127.0.0.1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      });
      it('rejects single-label hostnames (no dot)', () => {
        expect(isMultiaddrRemotelyDialable('/dns/internal-relay/tcp/9090/p2p/12D3Koo...')).toBe(false);
      });
    });
  });
});
