import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { resolveDaemonPublishEncryption } from '../src/daemon/lifecycle.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

describe('daemon publish encryption factory', () => {
  const hooks = {
    encryptInlinePayload: async (plaintext: Uint8Array) => plaintext,
    encryptInlineChunked: async () => ({
      ciphertextChunksRoot: new Uint8Array(32),
      ciphertextChunkCount: 0,
      totalCiphertextBytes: 0,
      ciphertextChunks: [],
    }),
  };

  it('treats async-lift publishContextGraphId as binding-only for LU-5 and LU-11', async () => {
    const agentLike = { _resolveInlineEncryption: recorder(async () => hooks) } as any;

    const resolved = await resolveDaemonPublishEncryption(agentLike, {
      contextGraphId: 'sports',
      subGraphName: 'league',
      publishContextGraphId: '1',
    });

    expect(resolved).toBe(hooks);
    expect(agentLike._resolveInlineEncryption.calls).toEqual([[
      'sports',
      'league',
      undefined,
      undefined,
      { aeadBindingContextGraphId: '1' },
    ]]);
  });

  it.each([undefined, '', '   '])('passes no binding when the job names no publish target (%j)', async (publishContextGraphId) => {
    const agentLike = { _resolveInlineEncryption: recorder(async () => hooks) } as any;

    await resolveDaemonPublishEncryption(agentLike, { contextGraphId: 'sports', publishContextGraphId });

    expect(agentLike._resolveInlineEncryption.calls).toEqual([['sports', undefined, undefined, undefined, undefined]]);
  });

  it('resolves one curated context for both hooks of a publish, and a new one for the next', async () => {
    const resolveContext = vi.fn(async () => ({
      chainKey: new Uint8Array(32).fill(7),
      aeadCgId: '1',
      senderAddress: '0x1111111111111111111111111111111111111111',
    }));
    // The agent's own resolver, so the count is of what a daemon publish really resolves.
    const agentLike = {
      _resolveInlineEncryption: DKGAgent.prototype._resolveInlineEncryption,
      _resolveCuratedChainKeyContext: resolveContext,
      log: { info: () => undefined, warn: () => undefined },
      gossipWireIdFor: (id: string) => id,
      resolveWorkspaceGossipSigningAgent: async () => ({
        privateKey: `0x${'11'.repeat(32)}`,
        agentAddress: '0x1111111111111111111111111111111111111111',
      }),
      canonicalChunkStoreCgIdOrNull: () => null,
      gossip: { publish: async () => undefined },
      store: { insert: async () => undefined },
    } as any;
    const publishOptions = { contextGraphId: 'sports', subGraphName: 'league', publishContextGraphId: '1' };

    const resolved = await resolveDaemonPublishEncryption(agentLike, publishOptions);

    expect(resolved.encryptInlinePayload).toBeTypeOf('function');
    expect(resolved.encryptInlineChunked).toBeTypeOf('function');
    expect(resolveContext.mock.calls).toEqual([
      ['sports', 'league', undefined, undefined, 'LU-5', { aeadBindingContextGraphId: '1' }],
    ]);

    await resolveDaemonPublishEncryption(agentLike, publishOptions);
    expect(resolveContext).toHaveBeenCalledTimes(2);
  });
});
