/**
 * Regression coverage for LU-5 inline-payload encryption policy.
 *
 * Numeric context graph ids are chain-owned policy surfaces. If the
 * daemon cannot read chain truth for one of them, publishing must fail
 * closed instead of falling back to plaintext.
 */
import { describe, it, expect, vi } from 'vitest';
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = vi.fn(async () => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  if (opts.activeOnChain !== 'absent') {
    chain.isContextGraphActiveOnChain = vi.fn(async () => opts.activeOnChain ?? true);
  }
  const agentLike = {
    log,
    chain,
    onChainAccessPolicyCache: new Map<string, 0 | 1>(),
    isPrivateContextGraph: vi.fn(async () => opts.isPrivate ?? false),
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
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(agentLike.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('fails closed when numeric target CG policy lookup is unavailable', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
    expect(agentLike.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('treating as UNKNOWN'),
    );
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
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
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
    const contextGraphExists = vi.fn(async (id: string) => {
      if (id === '42') throw new Error('numeric local lookup should not run');
      return false;
    });
    const agentLike = {
      ...makeAgentLike({ accessPolicy: 0 }),
      getContextGraphOnChainId: vi.fn(async () => null),
      contextGraphExists,
    };

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).resolves.toBeUndefined();
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(contextGraphExists).not.toHaveBeenCalledWith('42');
  });
});

describe('DKGAgent._publish inline encryption routing', () => {
  it('does not trust caller accessPolicy=public to bypass chain-confirmed encryption resolution', async () => {
    const encryptInlinePayload = vi.fn(async (plaintext: Uint8Array) => plaintext);
    const encryptInlineChunked = vi.fn();
    const publisherPublish = vi.fn(async () => ({
      status: 'confirmed',
      kaId: '1',
    }));
    const agentLike = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      subscribedContextGraphs: new Set(['local-cg']),
      contextGraphExists: vi.fn(async () => true),
      createV10ACKProvider: vi.fn(() => undefined),
      getContextGraphOnChainId: vi.fn(async () => '42'),
      chain: {},
      peerId: 'peer-1',
      publisher: {
        publish: publisherPublish,
      },
      broadcastPublish: vi.fn(async () => undefined),
      _resolveEncryptInlinePayload: vi.fn(async () => encryptInlinePayload),
      _resolveEncryptInlineChunked: vi.fn(async () => encryptInlineChunked),
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

    expect(agentLike._resolveEncryptInlinePayload).toHaveBeenCalledWith(
      'local-cg',
      'sg-a',
      undefined,
      '42',
    );
    expect(agentLike._resolveEncryptInlineChunked).toHaveBeenCalledWith(
      'local-cg',
      'sg-a',
      undefined,
      '42',
    );
    expect(publisherPublish).toHaveBeenCalledWith(expect.objectContaining({
      accessPolicy: 'public',
      publisherNodeIdentityIdOverride: 0n,
      encryptInlinePayload,
      encryptInlineChunked,
    }));
  });
});

describe('DKGAgent._resolveEncryptInlineChunked nonce domain', () => {
  it('uses publishOperationId, not batchId, as the chunked AEAD nonce domain', async () => {
    const signer = ethers.Wallet.createRandom();
    const agentLike = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      store: {
        insert: vi.fn(async () => {}),
      },
      canonicalChunkStoreCgIdOrNull: vi.fn((cgId: string) => cgId),
      gossip: {
        publish: vi.fn(async () => {}),
      },
      gossipWireIdFor: vi.fn((cgId: string) => cgId),
      _resolveCuratedChainKeyContext: vi.fn(async () => ({
        chainKey: new Uint8Array(32).fill(7),
        aeadCgId: '42',
      })),
      resolveWorkspaceGossipSigningAgent: vi.fn(async () => ({
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

  it('persists emitted chunks locally before gossip so local self-ACK does not depend on loopback', async () => {
    const gossipSigner = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const insertSpy = vi.spyOn(store, 'insert');
    const canonicalSwmCgId = '0x0609dca0015B271455C89D37501f530c89814a78';
    const swmGraphId = `${canonicalSwmCgId}/test-kafka-endpoint-registration`;
    const targetOnChainCgId = '40';
    const batchId = ethers.getBytes(ethers.id('lu11-self-ack-batch'));

    const agentLike = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      store,
      canonicalChunkStoreCgIdOrNull: vi.fn((raw: string) => (raw === swmGraphId ? canonicalSwmCgId : null)),
      gossip: {
        publish: vi.fn(async () => {}),
      },
      gossipWireIdFor: vi.fn((cgId: string) => cgId),
      _resolveCuratedChainKeyContext: vi.fn(async () => ({
        chainKey: new Uint8Array(32).fill(7),
        aeadCgId: targetOnChainCgId,
      })),
      resolveWorkspaceGossipSigningAgent: vi.fn(async () => ({
        privateKey: gossipSigner.privateKey,
        agentAddress: gossipSigner.address,
      })),
    } as any;

    const encryptInlineChunked = await (DKGAgent.prototype as any)
      ._resolveEncryptInlineChunked.call(agentLike, swmGraphId, undefined, undefined, targetOnChainCgId);
    expect(encryptInlineChunked).toBeDefined();

    const result = await encryptInlineChunked({
      plaintextNquads: new TextEncoder().encode('<urn:self> <urn:p> "ack" <urn:g> .\n'),
      batchId,
      publishOperationId: 'publish-op-self-ack',
    });

    expect(result.ciphertextChunkCount).toBe(1);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.invocationCallOrder[0])
      .toBeLessThan(agentLike.gossip.publish.mock.invocationCallOrder[0]);
    expect(insertSpy.mock.calls[0][0][0]).toMatchObject({
      subject: ciphertextChunkStoreSubject(batchId, 0),
      predicate: CIPHERTEXT_CHUNK_PREDICATE,
      graph: ciphertextChunkStoreGraph(canonicalSwmCgId),
    });
    expect(agentLike.log.debug).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(`graph=${ciphertextChunkStoreGraph(canonicalSwmCgId)}`),
    );
    expect(agentLike.log.debug).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(`subject=${ciphertextChunkStoreSubject(batchId, 0)}`),
    );

    const handler = new StorageACKHandler(
      store as any,
      {
        nodeRole: 'core',
        nodeIdentityId: 7n,
        signerWallet: ackSigner,
        chainId: 31337n,
        kav10Address: '0x000000000000000000000000000000000000c10a',
        contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
        isCgCurated: async () => true,
        normalizeContextGraphIdForChunkStore: (raw: string) => (
          raw === swmGraphId ? canonicalSwmCgId : null
        ),
        _v2ChunkLookupRetryPolicyForTests: { maxRetries: 0, delayMs: 0 },
      },
      { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any,
    );

    const intent = encodePublishIntent({
      merkleRoot: batchId,
      contextGraphId: targetOnChainCgId,
      swmGraphId,
      publisherPeerId: 'local-publisher-peer',
      publicByteSize: result.totalCiphertextBytes,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: 1,
      rootEntities: ['urn:self'],
      stagingQuads: new Uint8Array(0),
      ackProtocolVersion: ACK_PROTOCOL_VERSION_V2_LU11,
      ciphertextChunksRoot: result.ciphertextChunksRoot,
      ciphertextChunkCount: result.ciphertextChunkCount,
    });

    const ack = decodeStorageACK(await handler.handler(intent, { toString: () => 'local-publisher-peer' } as any));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ack.contextGraphId).toBe(targetOnChainCgId);
  });
});
