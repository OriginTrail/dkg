import { describe, it, expect } from 'vitest';
import {
  buildPeerStoreOverrides,
  buildKadDHTOptions,
  pickNetworkTunables,
} from '../src/node.js';

// PR feat/chain-network-libp2p-tunables, round 2 (Codex review of PR
// #698): the round-1 `cli/test/config.test.ts` cases only proved that
// `network.peerStoreMaxAddressAgeMs` / `network.peerStoreMaxPeerAgeMs`
// / `network.dhtQuerySelfIntervalMs` survive a config save/load
// round-trip. They did NOT prove the values actually reach
// `createLibp2p({ peerStore: {...} })` and `kadDHT({...})` under the
// libp2p-expected key names. A typo like `maxAddrAge` would have
// shipped as a silent no-op while the round-1 suite still passed.
//
// These tests pin the wiring at the pure-helper boundary that
// `DKGNode.start()` consumes, so a regression in the option key
// names or a regression that drops a valid value would fail here
// before reaching a libp2p version pin.

describe('buildPeerStoreOverrides', () => {
  it('returns undefined when neither field is supplied', () => {
    expect(buildPeerStoreOverrides({})).toBeUndefined();
  });

  it('returns undefined when both fields are invalid (defensive)', () => {
    // Permissive validator: invalid values silently fall back to the
    // libp2p default — we MUST return `undefined` so `createLibp2p` is
    // invoked WITHOUT a `peerStore` block (anything else would override
    // a default the operator never asked us to touch).
    for (const bad of [NaN, 0, -1, 1.5, Infinity, -Infinity]) {
      expect(
        buildPeerStoreOverrides({
          peerStoreMaxAddressAgeMs: bad,
          peerStoreMaxPeerAgeMs: bad,
        }),
      ).toBeUndefined();
    }
  });

  it('emits the exact libp2p key `maxAddressAge` when only that is set', () => {
    // Key-name pin: this is the regression fence Codex asked for.
    const out = buildPeerStoreOverrides({
      peerStoreMaxAddressAgeMs: 24 * 3_600_000,
    });
    expect(out).toEqual({ maxAddressAge: 24 * 3_600_000 });
    // Belt-and-suspenders: the other slot MUST NOT be present (we want
    // libp2p to keep its default for unspecified fields, not receive
    // `undefined` and choke on the type check).
    expect(out).not.toHaveProperty('maxPeerAge');
  });

  it('emits the exact libp2p key `maxPeerAge` when only that is set', () => {
    const out = buildPeerStoreOverrides({
      peerStoreMaxPeerAgeMs: 7 * 24 * 3_600_000,
    });
    expect(out).toEqual({ maxPeerAge: 7 * 24 * 3_600_000 });
    expect(out).not.toHaveProperty('maxAddressAge');
  });

  it('emits both keys when both are set', () => {
    const out = buildPeerStoreOverrides({
      peerStoreMaxAddressAgeMs: 60_000,
      peerStoreMaxPeerAgeMs: 120_000,
    });
    expect(out).toEqual({ maxAddressAge: 60_000, maxPeerAge: 120_000 });
  });

  it('drops invalid `peerStoreMaxAddressAgeMs` but keeps valid `peerStoreMaxPeerAgeMs`', () => {
    const out = buildPeerStoreOverrides({
      peerStoreMaxAddressAgeMs: 0,
      peerStoreMaxPeerAgeMs: 120_000,
    });
    expect(out).toEqual({ maxPeerAge: 120_000 });
    expect(out).not.toHaveProperty('maxAddressAge');
  });
});

describe('pickNetworkTunables (forwarding-hop fence)', () => {
  // PR feat/chain-network-libp2p-tunables, round 3 (Codex review of
  // PR #698): round-2's test pinned the lowest layer
  // (`buildPeerStoreOverrides` / `buildKadDHTOptions`) against the
  // libp2p init keys. The two forwarding hops above that —
  // `DkgConfig.network` → `DKGAgentConfig` (in
  // `cli/src/daemon/lifecycle.ts`) and `DKGAgentConfig` →
  // `DKGNodeConfig` (in `agent/src/dkg-agent.ts`) — were still
  // unfenced. Both now route through `pickNetworkTunables`, so the
  // tests below are the single regression fence for the whole chain.
  // A typo at any caller is a compile-time failure (the helper's
  // return type is `NetworkTunables`); a copy-paste-cross bug at
  // the helper itself is what these tests catch.

  it('returns an empty-valued shape when source is empty', () => {
    // We MUST return all three keys (even when undefined) so that
    // spread-merging at the call site keeps the property names
    // explicit in the resulting config object — easier to grep for
    // when debugging.
    expect(pickNetworkTunables({})).toEqual({
      peerStoreMaxAddressAgeMs: undefined,
      peerStoreMaxPeerAgeMs: undefined,
      dhtQuerySelfIntervalMs: undefined,
    });
  });

  it('forwards each field to the SAME-named slot (no copy-paste-cross)', () => {
    // Distinct integers — a swap like
    // `peerStoreMaxAddressAgeMs ← source.peerStoreMaxPeerAgeMs`
    // would surface here as a value mismatch.
    const out = pickNetworkTunables({
      peerStoreMaxAddressAgeMs: 111,
      peerStoreMaxPeerAgeMs: 222,
      dhtQuerySelfIntervalMs: 333,
    });
    expect(out).toEqual({
      peerStoreMaxAddressAgeMs: 111,
      peerStoreMaxPeerAgeMs: 222,
      dhtQuerySelfIntervalMs: 333,
    });
  });

  it('ignores extra fields on the source (defensive against partial supersets)', () => {
    // The forwarding hops pass `DkgConfig.network` (cli) and
    // `DKGAgentConfig` (agent) — both have many other fields. The
    // helper must not leak any of them into the result, otherwise
    // a spread would pollute the downstream config object.
    const out = pickNetworkTunables({
      peerStoreMaxAddressAgeMs: 111,
      // @ts-expect-error testing runtime defensive behaviour
      unrelated: 'ignored',
    });
    expect(out).toEqual({
      peerStoreMaxAddressAgeMs: 111,
      peerStoreMaxPeerAgeMs: undefined,
      dhtQuerySelfIntervalMs: undefined,
    });
    expect(out).not.toHaveProperty('unrelated');
  });
});

describe('buildKadDHTOptions', () => {
  it('always returns the protocol (no silent fallthrough to upstream default)', () => {
    const out = buildKadDHTOptions({}, '/dkg/test/kad/1.0.0');
    expect(out).toEqual({ protocol: '/dkg/test/kad/1.0.0' });
    expect(out).not.toHaveProperty('querySelfInterval');
  });

  it('emits the exact libp2p key `querySelfInterval` when supplied', () => {
    // Key-name pin: a typo like `querySelfInteval` in the helper would
    // fail the test below AND fail the TypeScript return-type check.
    const out = buildKadDHTOptions(
      { dhtQuerySelfIntervalMs: 60_000 },
      '/dkg/test/kad/1.0.0',
    );
    expect(out).toEqual({
      protocol: '/dkg/test/kad/1.0.0',
      querySelfInterval: 60_000,
    });
  });

  it('drops invalid `dhtQuerySelfIntervalMs` values (defensive)', () => {
    for (const bad of [NaN, 0, -1, 1.5, Infinity, -Infinity]) {
      const out = buildKadDHTOptions(
        { dhtQuerySelfIntervalMs: bad },
        '/dkg/test/kad/1.0.0',
      );
      expect(out, `bad value: ${bad}`).toEqual({
        protocol: '/dkg/test/kad/1.0.0',
      });
      expect(out, `bad value: ${bad}`).not.toHaveProperty('querySelfInterval');
    }
  });
});
