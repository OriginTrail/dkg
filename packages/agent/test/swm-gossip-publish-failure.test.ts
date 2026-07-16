import { describe, it, expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

class ThrowingGossip {
  publishAttempts: Array<{ topic: string; bytes: number }> = [];

  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(_topic: string, _handler: (topic: string, data: Uint8Array, from?: string) => void | Promise<void>): void {}

  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.publishAttempts.push({ topic, bytes: data.byteLength });
    throw new Error(`simulated mesh failure for ${topic}`);
  }

  // rc.9 PR-C: the tier-switch in publishWorkspaceGossip consults
  // GossipSubManager.getSubscribers via the CGMemberEnumerator.
  // Returning [] keeps these PR-A regression tests focused on the
  // gossip-failure path: no topic subscribers + no allowlist =>
  // `source: 'none'` => `useSubstrate: false, useGossip: true`,
  // so the share takes the gossip-only branch and exercises the
  // PR-A counter exactly like it did before PR-C.
  getSubscribers(_topic: string): string[] { return []; }
}

// PR-A R6 regression: throws a named, non-generic error class so the
// WARN line can record both the class name and the message. Pre-fix
// the catch block only logged err.message, collapsing distinct types
// like `NoPeersSubscribedError` into the same log shape.
class NoPeersSubscribedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoPeersSubscribedError';
  }
}

class TypedThrowingGossip {
  publishAttempts: Array<{ topic: string; bytes: number }> = [];
  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(_topic: string, _handler: (topic: string, data: Uint8Array, from?: string) => void | Promise<void>): void {}
  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.publishAttempts.push({ topic, bytes: data.byteLength });
    throw new NoPeersSubscribedError(`no peers subscribed to ${topic}`);
  }
  getSubscribers(_topic: string): string[] { return []; }
}

describe('DKGAgent SWM gossip publish failure (rc.9 PR-A)', () => {
  it('reports zero publish failures before any share has been attempted', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureZero',
      chainAdapter: new MockChainAdapter(),
    });

    expect(agent.getSwmGossipStats()).toEqual({
      publishFailures: {},
      publishFailuresOverflow: 0,
      publishFailuresTruncated: false,
    });
  });

  it('bumps the per-cgId failure counter when gossip.publish throws, and share() still succeeds', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureBump',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new ThrowingGossip();
    (agent as unknown as { gossip: ThrowingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWPublisherLoudFail' },
      configurable: true,
    });

    const contextGraphId = 'swm-pub-fail-cg-a';

    const result = await agent.share(contextGraphId, [{
      subject: 'urn:test:loud-fail',
      predicate: 'http://schema.org/name',
      object: '"local commit succeeded"',
      graph: '',
    }]);

    expect(typeof result.shareOperationId).toBe('string');
    expect(result.shareOperationId.length).toBeGreaterThan(0);

    expect(gossip.publishAttempts).toHaveLength(1);
    expect(gossip.publishAttempts[0]?.topic).toMatch(/shared-memory$/);

    expect(agent.getSwmGossipStats()).toEqual({
      publishFailures: { [contextGraphId]: 1 },
      publishFailuresOverflow: 0,
      publishFailuresTruncated: false,
    });
  });

  it('isolates the counter per cgId and accumulates across calls', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureMulti',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new ThrowingGossip();
    (agent as unknown as { gossip: ThrowingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWPublisherMulti' },
      configurable: true,
    });

    const cgA = 'swm-pub-fail-cg-multi-a';
    const cgB = 'swm-pub-fail-cg-multi-b';

    await agent.share(cgA, [{ subject: 'urn:t:1', predicate: 'http://schema.org/name', object: '"A1"', graph: '' }]);
    await agent.share(cgA, [{ subject: 'urn:t:2', predicate: 'http://schema.org/name', object: '"A2"', graph: '' }]);
    await agent.share(cgB, [{ subject: 'urn:t:3', predicate: 'http://schema.org/name', object: '"B1"', graph: '' }]);

    expect(agent.getSwmGossipStats()).toEqual({
      publishFailures: { [cgA]: 2, [cgB]: 1 },
      publishFailuresOverflow: 0,
      publishFailuresTruncated: false,
    });
  });

  // PR-A R8 regression: once the cap is hit, a brand-new cgId with
  // count=1 MUST evict itself into overflow (not push out an existing
  // hot cgId). The pre-R8 eviction always protected the just-
  // incremented entry, so a stream of one-off failures could
  // displace hot cgIds. Post-fix, the comparison is global — the
  // smallest count wins eviction, even if that's the new entry.
  it('hot cgId survives a stream of one-off failures against fresh cgIds (R8)', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureR8Hot',
      chainAdapter: new MockChainAdapter(),
    });
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWPublisherR8' },
      configurable: true,
    });

    const internals = agent as unknown as {
      swmGossipPublishFailures: Map<string, number>;
      recordSwmGossipPublishFailure: (cgId: string) => { failureCountForCg: number; evictedToOverflow: boolean };
    };
    const Cls = (agent.constructor as unknown as { SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS: number });
    const cap = Cls.SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS;

    for (let i = 0; i < 10; i++) {
      internals.recordSwmGossipPublishFailure('cg-hot');
    }
    for (let i = 0; i < cap; i++) {
      internals.recordSwmGossipPublishFailure(`cg-cold-${i}`);
    }
    for (let i = 0; i < 50; i++) {
      internals.recordSwmGossipPublishFailure(`cg-oneoff-${i}`);
    }

    const stats = agent.getSwmGossipStats();
    expect(stats.publishFailuresTruncated).toBe(true);
    expect(stats.publishFailures['cg-hot']).toBe(10);
    expect(Object.keys(stats.publishFailures).length).toBeLessThanOrEqual(cap);
  });

  // PR-A R5 regression: failures against thousands of distinct cgIds
  // must not unboundedly grow the per-cgId map (and the /api/slo
  // payload). When we cross SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS the
  // smallest counter is evicted into `publishFailuresOverflow` and
  // the sticky `publishFailuresTruncated` flag flips. Test exercises
  // the eviction path by failing publishes against more cgIds than
  // the cap, with one "hot" cgId that should survive eviction.
  it('caps the per-cgId map + spills overflow + flips truncated flag (R5)', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureCap',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new ThrowingGossip();
    (agent as unknown as { gossip: ThrowingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWPublisherCap' },
      configurable: true,
    });

    const internals = agent as unknown as {
      swmGossipPublishFailures: Map<string, number>;
      recordSwmGossipPublishFailure: (cgId: string) => { failureCountForCg: number; evictedToOverflow: boolean };
    };
    const Cls = (agent.constructor as unknown as { SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS: number });
    const cap = Cls.SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS;

    for (let i = 0; i < 5; i++) {
      internals.recordSwmGossipPublishFailure('cg-hot');
    }
    for (let i = 0; i < cap; i++) {
      internals.recordSwmGossipPublishFailure(`cg-cold-${i}`);
    }

    const stats = agent.getSwmGossipStats();
    expect(stats.publishFailuresTruncated).toBe(true);
    expect(stats.publishFailuresOverflow).toBeGreaterThan(0);
    expect(stats.publishFailures['cg-hot']).toBe(5);
    expect(Object.keys(stats.publishFailures).length).toBeLessThanOrEqual(cap);
  });

  // PR-A R6 regression: the WARN line includes the error CLASS, not
  // just err.message. Pre-fix the comment claimed "error class" but
  // the code only logged err.message, so a NoPeersSubscribedError and
  // a generic transport error looked identical in daemon.log.
  it('WARN log carries the error class name distinct from the error message (R6)', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureErrClass',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new TypedThrowingGossip();
    (agent as unknown as { gossip: TypedThrowingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWPublisherTyped' },
      configurable: true,
    });

    const captured: Array<{ ctx: unknown; message: string }> = [];
    const originalWarn = (agent as unknown as { log: { warn: (ctx: unknown, msg: string) => void } }).log.warn.bind(
      (agent as unknown as { log: { warn: (ctx: unknown, msg: string) => void } }).log,
    );
    (agent as unknown as { log: { warn: (ctx: unknown, msg: string) => void } }).log.warn = (ctx, message) => {
      captured.push({ ctx, message });
      originalWarn(ctx, message);
    };

    await agent.share('swm-pub-fail-cg-err-class', [{
      subject: 'urn:test:err-class',
      predicate: 'http://schema.org/name',
      object: '"typed failure"',
      graph: '',
    }]);

    const warn = captured.find((c) => /Gossip publish FAILED/.test(c.message));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('errorClass="NoPeersSubscribedError"');
    expect(warn!.message).toContain('error="no peers subscribed to');
  });

  // PR-A R12 regression: when the per-cgId tracking map is at the
  // cap AND the just-incremented entry is the one evicted into the
  // overflow bucket on the same call, the WARN log must still
  // report the actual post-increment count (≥1), not the stale 0
  // returned by re-reading the map after eviction. The log line
  // also flags the overflow case so operators can see why this
  // cgId won't show up in /api/slo's per-cgId breakdown.
  it('WARN log reports accurate failureCountForCg even when the entry is evicted to overflow (R12)', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGossipFailureR12Overflow',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new TypedThrowingGossip();
    (agent as unknown as { gossip: TypedThrowingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWPublisherR12' },
      configurable: true,
    });

    const internals = agent as unknown as {
      swmGossipPublishFailures: Map<string, number>;
      recordSwmGossipPublishFailure: (cgId: string) => { failureCountForCg: number; evictedToOverflow: boolean };
    };
    const Cls = (agent.constructor as unknown as { SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS: number });
    const cap = Cls.SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS;

    // Saturate the cap with hot cgIds (count >= 2 each) so the
    // smallest entry after the next single bump will be the new one.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < cap; i++) {
        internals.recordSwmGossipPublishFailure(`cg-hot-${i}`);
      }
    }

    const captured: Array<{ message: string }> = [];
    const originalWarn = (agent as unknown as { log: { warn: (ctx: unknown, msg: string) => void } }).log.warn.bind(
      (agent as unknown as { log: { warn: (ctx: unknown, msg: string) => void } }).log,
    );
    (agent as unknown as { log: { warn: (ctx: unknown, msg: string) => void } }).log.warn = (ctx, message) => {
      captured.push({ message });
      originalWarn(ctx, message);
    };

    // This share will go through publishWorkspaceGossip, which fails
    // and calls recordSwmGossipPublishFailure for a brand-new cgId
    // (count=1) — guaranteed to be the smallest and thus the one
    // evicted into overflow. Pre-R12, the WARN log re-read the map
    // after eviction and printed failureCountForCg=0.
    const newCg = 'swm-pub-fail-cg-overflow-new';
    await agent.share(newCg, [{
      subject: 'urn:test:overflow',
      predicate: 'http://schema.org/name',
      object: '"will overflow"',
      graph: '',
    }]);

    const warn = captured.find((c) => /Gossip publish FAILED/.test(c.message) && new RegExp(`cgId=${newCg}\\b`).test(c.message));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('failureCountForCg=1');
    expect(warn!.message).not.toContain('failureCountForCg=0');
    expect(warn!.message).toContain('evicted to overflow bucket');

    const stats = agent.getSwmGossipStats();
    expect(stats.publishFailuresTruncated).toBe(true);
    // The new cgId itself should NOT appear in the per-cgId map
    // (it was evicted into overflow on the very same call).
    expect(stats.publishFailures[newCg]).toBeUndefined();
    expect(stats.publishFailuresOverflow).toBeGreaterThanOrEqual(1);
  });

  it('initialises receiver-side handler stats as empty even before any share is received', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmHandlerStatsEmpty',
      chainAdapter: new MockChainAdapter(),
    });

    expect(agent.getSwmHandlerStats()).toEqual({
      redundantApplies: {},
      redundantAppliesLowerBound: false,
      redundantAppliesOverflow: 0,
      redundantAppliesTruncated: false,
    });
  });
});
