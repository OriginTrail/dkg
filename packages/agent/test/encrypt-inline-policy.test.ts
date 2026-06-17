/**
 * Regression coverage for LU-5 inline-payload encryption policy.
 *
 * Numeric context graph ids are chain-owned policy surfaces. If the
 * daemon cannot read chain truth for one of them, publishing must fail
 * closed instead of falling back to plaintext.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  ACK_PROTOCOL_VERSION_V2_LU11,
  ciphertextChunkStoreGraph,
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
  decodeStorageACK,
  encodePublishIntent,
  isStorageACKDecline,
} from '@origintrail-official/dkg-core';
import { StorageACKHandler } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

// Hand-rolled call recorder (replaces vitest spy factories): wraps an
// implementation, records every argument tuple on `.calls`, captures a
// monotonic invocation sequence on `.order`, and returns the impl's result.
let invocationSeq = 0;
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const order: number[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    order.push(invocationSeq++);
    return impl(...args);
  };
  return Object.assign(fn, { calls, order });
}

function makeAgentLike(opts: {
  isPrivate?: boolean;
  accessPolicy?: 0 | 1;
  accessPolicyError?: Error;
  exposeAccessPolicy?: boolean;
  // chain.isContextGraphActiveOnChain liveness probe — the gate the numeric
  // branch of isContextGraphPublicOnChain now depends on. `true` (default) →
  // the slot is registered & live; `false` → unknown / not live; `'absent'` →
  // the probe isn't implemented.
  activeOnChain?: boolean | 'absent';
} = {}) {
  const log = {
    info: recorder(() => undefined),
    warn: recorder(() => undefined),
    error: recorder(() => undefined),
    debug: recorder(() => undefined),
  };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = recorder(async () => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  if (opts.activeOnChain !== 'absent') {
    chain.isContextGraphActiveOnChain = recorder(async () => opts.activeOnChain ?? true);
  }
  const agentLike = {
    log,
    chain,
    onChainAccessPolicyCache: new Map<string, 0 | 1>(),
    isPrivateContextGraph: recorder(async () => opts.isPrivate ?? false),
  } as any;
  // `probeIsCurated` now consults the on-chain-public override first; bind
  // the real prototype method so the harness exercises production code.
  agentLike.isContextGraphPublicOnChain = (DKGAgent.prototype as any).isContextGraphPublicOnChain;
  // #884 review: a bare-numeric id is trusted as public ONLY after a LIVE
  // on-chain proof (isContextGraphActiveOnChain) — the chain returns
  // access-policy 0 (= public) for UNKNOWN ids, so an unregistered numeric id
  // must never be classified public. The probe above (default live) lets the
  // public-CG cases pass; the registration-proof case opts out with `false`.
  // isContextGraphPublicOnChain / probeIsCurated route their chain reads
  // through readLiveOnChainAccessPolicy (which wraps raceChainPolicyRead) —
  // bind both so `this.readLiveOnChainAccessPolicy` / `this.raceChainPolicyRead`
  // exist on the harness.
  agentLike.readLiveOnChainAccessPolicy = (DKGAgent.prototype as any).readLiveOnChainAccessPolicy;
  agentLike.resolveOnChainAccessPolicyState = (DKGAgent.prototype as any).resolveOnChainAccessPolicyState;
  agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
  agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
  return agentLike;
}

async function resolveEncryptInlinePayload(
  agentLike: any,
  contextGraphId: string,
  publishContextGraphId?: string,
) {
  // RFC-39 / LU-11 refactor extracted the access-policy probe + curated
  // bootstrap into the private helper `_resolveCuratedChainKeyContext`,
  // which `_resolveEncryptInlinePayload` now delegates to before returning
  // either the AEAD callback or `undefined`. The lightweight `agentLike`
  // harness in this file does not extend `DKGAgent.prototype`, so we must
  // also bind the helper here — otherwise the first call throws
  // `TypeError: this._resolveCuratedChainKeyContext is not a function`
  // before any of the policy assertions below can run. All test cases in
  // this file short-circuit inside the policy probe (public CG → undefined,
  // unknown policy → throw) so they never touch the curated bootstrap
  // dependencies (`createAndDistributeSwmSenderKeyEpoch` etc.).
  agentLike._resolveCuratedChainKeyContext = (DKGAgent.prototype as any)
    ._resolveCuratedChainKeyContext;
  return (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(
    agentLike,
    contextGraphId,
    undefined,
    undefined,
    publishContextGraphId,
  );
}

describe('DKGAgent._resolveEncryptInlinePayload policy lookup', () => {
  it('keeps non-numeric local public CGs on the plaintext path', async () => {
    const agentLike = makeAgentLike({ exposeAccessPolicy: false });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg')).resolves.toBeUndefined();
  });

  it('uses chain policy for numeric public CGs before choosing plaintext', async () => {
    const agentLike = makeAgentLike({ accessPolicy: 0 });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).resolves.toBeUndefined();
    expect(agentLike.chain.getContextGraphAccessPolicy.calls.at(-1)).toEqual([42n]);
    expect(agentLike.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('fails closed when numeric target CG policy lookup is unavailable', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
    expect(agentLike.log.warn.calls.at(-1)).toEqual([
      expect.anything(),
      expect.stringContaining('treating as UNKNOWN'),
    ]);
  });

  it('fails closed when numeric target CG policy getter is missing', async () => {
    const agentLike = makeAgentLike({ exposeAccessPolicy: false });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
  });

  it('does NOT classify an UNREGISTERED (not live) numeric id as public (liveness gate) (#884 review)', async () => {
    // The liveness probe reports slot 999 NOT active. Even though the chain
    // getter would return the permissive default (0) for an unknown id, the
    // gate must short-circuit isContextGraphPublicOnChain to false BEFORE any
    // access-policy read — proving the suite exercises the live-on-chain proof
    // rather than blanket-trusting numeric strings.
    const agentLike = makeAgentLike({ accessPolicy: 0, activeOnChain: false });
    await expect(
      (DKGAgent.prototype as any).isContextGraphPublicOnChain.call(agentLike, '999'),
    ).resolves.toBe(false);
    expect(agentLike.chain.getContextGraphAccessPolicy.calls).toEqual([]);
  });

  it('fails closed when a remap target numeric CG policy cannot be resolved', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).rejects.toThrow(
      /target CG "42" curated=unknown/,
    );
  });

  it('treats an explicit numeric remap target as a raw on-chain slot', async () => {
    const contextGraphExists = recorder(async (id: string) => {
      if (id === '42') throw new Error('numeric local lookup should not run');
      return false;
    });
    const agentLike = {
      ...makeAgentLike({ accessPolicy: 0 }),
      getContextGraphOnChainId: recorder(async () => null),
      contextGraphExists,
    };

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).resolves.toBeUndefined();
    expect(agentLike.chain.getContextGraphAccessPolicy.calls.at(-1)).toEqual([42n]);
    expect(contextGraphExists.calls).not.toContainEqual(['42']);
  });
});

describe('DKGAgent._publish inline encryption routing', () => {
  it('does not trust caller accessPolicy=public to bypass chain-confirmed encryption resolution', async () => {
    const encryptInlinePayload = recorder(async (plaintext: Uint8Array) => plaintext);
    const encryptInlineChunked = recorder(() => undefined);
    const publisherPublish = recorder(async () => ({
      status: 'confirmed',
      kaId: '1',
    }));
    const agentLike = {
      log: {
        info: recorder(() => undefined),
        warn: recorder(() => undefined),
        error: recorder(() => undefined),
        debug: recorder(() => undefined),
      },
      subscribedContextGraphs: new Set(['local-cg']),
      contextGraphExists: recorder(async () => true),
      createV10ACKProvider: recorder(() => undefined),
      getContextGraphOnChainId: recorder(async () => '42'),
      chain: {},
      peerId: 'peer-1',
      publisher: {
        publish: publisherPublish,
      },
      broadcastPublish: recorder(async () => undefined),
      // OT-RFC-49: _publish now refreshes the public catalog projection after a
      // confirmed publish (no-op unless configured). Stub it on the mock.
      emitPublicProjectionAfterPublish: recorder(async () => undefined),
      _resolveEncryptInlinePayload: recorder(async () => encryptInlinePayload),
      _resolveEncryptInlineChunked: recorder(async () => encryptInlineChunked),
    } as any;

    await (DKGAgent.prototype as any)._publish.call(
      agentLike,
      'local-cg',
      [{ subject: 's', predicate: 'p', object: 'o', graph: 'g' }],
      undefined,
      {
        accessPolicy: 'public',
        subGraphName: 'sg-a',
        publisherNodeIdentityIdOverride: 0n,
      },
    );

    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'local-cg',
      'sg-a',
      undefined,
      '42',
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'local-cg',
      'sg-a',
      undefined,
      '42',
    ]);
    expect(publisherPublish.calls.at(-1)).toEqual([expect.objectContaining({
      accessPolicy: 'public',
      publisherNodeIdentityIdOverride: 0n,
      encryptInlinePayload,
      encryptInlineChunked,
    })]);
  });
});

describe('DKGAgent._resolveEncryptInlineChunked nonce domain', () => {
  it('uses publishOperationId, not batchId, as the chunked AEAD nonce domain', async () => {
    const signer = ethers.Wallet.createRandom();
    const agentLike = {
      log: {
        info: recorder(() => undefined),
        warn: recorder(() => undefined),
        error: recorder(() => undefined),
        debug: recorder(() => undefined),
      },
      store: {
        insert: recorder(async () => {}),
      },
      canonicalChunkStoreCgIdOrNull: recorder((cgId: string) => cgId),
      gossip: {
        publish: recorder(async () => {}),
      },
      gossipWireIdFor: recorder((cgId: string) => cgId),
      _resolveCuratedChainKeyContext: recorder(async () => ({
        chainKey: new Uint8Array(32).fill(7),
        aeadCgId: '42',
      })),
      resolveWorkspaceGossipSigningAgent: recorder(async () => ({
        privateKey: signer.privateKey,
        agentAddress: signer.address,
      })),
    } as any;

    const encryptInlineChunked = await (DKGAgent.prototype as any)
      ._resolveEncryptInlineChunked.call(agentLike, '42');
    expect(encryptInlineChunked).toBeDefined();

    const batchId = ethers.getBytes(ethers.id('same-merkle-root'));
    const plaintextNquads = new TextEncoder().encode(
      '<urn:a> <urn:p> "one" <urn:g> .\n<urn:b> <urn:p> "two" <urn:g> .',
    );

    const first = await encryptInlineChunked({
      plaintextNquads,
      batchId,
      publishOperationId: 'publish-op-1',
    });
    const second = await encryptInlineChunked({
      plaintextNquads,
      batchId,
      publishOperationId: 'publish-op-2',
    });

    expect(Buffer.from(first.ciphertextChunksRoot).toString('hex'))
      .not.toBe(Buffer.from(second.ciphertextChunksRoot).toString('hex'));
  });

});
