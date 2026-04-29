/**
 * signedGossipPublish MUST NOT
 * fall back to raw unsigned bytes when no wallet is available. Strict
 * peers (r14-1 default) would drop those, silently stopping propagation.
 *
 * These pins exercise the egress policy directly (the publish chain
 * is covered by the full integration test at `gossip-publish-handler`;
 * here we verify the boundary contract).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent, SignedGossipSigningError } from '../src/dkg-agent.js';

function makeFakeAgent(overrides: {
  wallet?: unknown;
  gossipPublish?: (topic: string, data: Uint8Array) => Promise<void>;
} = {}) {
  const publishes: Array<{ topic: string; bytes: Uint8Array }> = [];
  const fake = Object.create(DKGAgent.prototype);
  fake.gossip = {
    publish: overrides.gossipPublish
      ?? (async (topic: string, data: Uint8Array) => {
        publishes.push({ topic, bytes: data });
      }),
  };
  fake.log = { warn: vi.fn() };
  fake.getDefaultPublisherWallet = () => overrides.wallet;
  return { agent: fake as DKGAgent, publishes };
}

describe('DKGAgent#signedGossipPublish — r16-1 egress invariant', () => {
  const savedEnv = { DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS: process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS };

  beforeEach(() => {
    delete process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS;
  });

  afterEach(() => {
    if (savedEnv.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS === undefined) {
      delete process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS;
    } else {
      process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS = savedEnv.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS;
    }
  });

  it('throws when no wallet is available (no silent fallback to raw bytes)', async () => {
    const { agent, publishes } = makeFakeAgent({ wallet: undefined });
    await expect(
      agent.signedGossipPublish('topic-x', 'PUBLISH_REQUEST', 'cg-1', new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/No signing wallet/i);
    expect(publishes).toHaveLength(0);
  });

  it('throw message mentions escape hatch (DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS) so operators know how to unblock', async () => {
    const { agent } = makeFakeAgent({ wallet: undefined });
    await expect(
      agent.signedGossipPublish('topic-y', 'SHARE', 'cg-2', new Uint8Array([9, 8, 7])),
    ).rejects.toThrow(/DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS/);
  });

  it('falls back to raw publish ONLY when DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS=1 is explicitly set', async () => {
    process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS = '1';
    const { agent, publishes } = makeFakeAgent({ wallet: undefined });
    await agent.signedGossipPublish('topic-z', 'SHARE_CAS', 'cg-3', new Uint8Array([4, 5, 6]));
    expect(publishes).toHaveLength(1);
    expect(publishes[0].topic).toBe('topic-z');
    // Raw bytes — not wrapped in an envelope.
    expect(Array.from(publishes[0].bytes)).toEqual([4, 5, 6]);
    // A WARN must fire every time we ship raw bytes.
    expect((agent as any).log.warn).toHaveBeenCalled();
    const args = ((agent as any).log.warn as any).mock.calls[0];
    expect(String(args[1])).toMatch(/publishing RAW/i);
  });

  it('opt-out accepts all canonical truthy aliases (1, true, yes)', async () => {
    for (const val of ['1', 'true', 'TRUE', 'YES', 'yes']) {
      process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS = val;
      const { agent, publishes } = makeFakeAgent({ wallet: undefined });
      await agent.signedGossipPublish('t', 'KA_UPDATE', 'cg-4', new Uint8Array([val.length]));
      expect(publishes).toHaveLength(1);
    }
  });

  it('unrecognised opt-out values (e.g. "maybe", "2") still throw — no silent fallback on typos', async () => {
    for (const val of ['maybe', '2', 'on', '']) {
      process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS = val;
      const { agent } = makeFakeAgent({ wallet: undefined });
      await expect(
        agent.signedGossipPublish('t', 'PUBLISH_REQUEST', 'cg-5', new Uint8Array([0])),
      ).rejects.toThrow(/No signing wallet/i);
    }
  });

  // ---------------------------------------------------------------------
  // the wallet-unavailable error MUST be a
  // *typed* `SignedGossipSigningError` so upstream `catch { log.warn(
  // 'no peers subscribed') }` blocks can discriminate "I cannot sign"
  // (a real correctness failure on strict-default meshes) from "libp2p
  // has no subscribers yet" (a benign warm-up state). Before this, BOTH
  // cases surfaced as a plain `Error` and got collapsed into the
  // misleading "no peers subscribed" path.
  // ---------------------------------------------------------------------
  it('wallet-unavailable throws a typed SignedGossipSigningError (name + instanceof)', async () => {
    const { agent } = makeFakeAgent({ wallet: undefined });
    try {
      await agent.signedGossipPublish('topic-sg', 'PUBLISH_REQUEST', 'cg-sg', new Uint8Array([1]));
      expect.fail('signedGossipPublish must reject when no wallet is available');
    } catch (err) {
      expect(err).toBeInstanceOf(SignedGossipSigningError);
      expect((err as Error).name).toBe('SignedGossipSigningError');
    }
  });

  it('transport (gossip.publish) errors pass through as the underlying Error, NOT SignedGossipSigningError', async () => {
    // A functional wallet is present; the envelope builds fine; only
    // the outbound libp2p publish fails. That error must remain the
    // native `Error` instance so the call-site catch can handle it as
    // the benign "no peers subscribed" path.
    const wallet = ethers.Wallet.createRandom();
    const transportErr = new Error('PublishError: no peers subscribed to topic');
    const { agent } = makeFakeAgent({
      wallet,
      gossipPublish: async () => { throw transportErr; },
    });
    await expect(
      agent.signedGossipPublish('topic-t', 'SHARE', 'cg-t', new Uint8Array([2])),
    ).rejects.toBe(transportErr);
  });

  it('envelope-build failures are wrapped in SignedGossipSigningError (preserves `cause`)', async () => {
    // Simulate a wallet missing the signing API expected by
    // `buildSignedGossipEnvelope` — the adapter must wrap the thrown
    // TypeError in a SignedGossipSigningError so downstream catches
    // see the correctness-bug tag, not a bare Error that they swallow
    // as "no peers subscribed".
    const brokenWallet = {
      address: '0x' + '22'.repeat(20),
      // No signMessageSync / signingKey — envelope builder will throw.
    };
    const { agent, publishes } = makeFakeAgent({ wallet: brokenWallet });
    try {
      await agent.signedGossipPublish('topic-b', 'FINALIZATION', 'cg-b', new Uint8Array([3]));
      expect.fail('must reject when envelope-build fails');
    } catch (err) {
      expect(err).toBeInstanceOf(SignedGossipSigningError);
      expect((err as Error).message).toMatch(/Failed to build signed envelope/i);
    }
    expect(publishes).toHaveLength(0);
  });
});
