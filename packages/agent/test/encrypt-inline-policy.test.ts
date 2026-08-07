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
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  contextGraphDataUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  decryptV10PublishPayload,
  encodePublishIntent,
  isStorageACKDecline,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  StorageACKHandler,
  catalogTripleKey,
  computeFlatKCRootV10,
  computePrivateRootV10,
  generatedPrivateCatalogFloorQuads,
  generatedPrivateCatalogTripleKeys,
  skolemizeKnowledgeAssetParts,
  type KnowledgeAssetVmPublishRequest,
} from '@origintrail-official/dkg-publisher';
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
  options?: { aeadBindingContextGraphId?: string },
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
    options,
  );
}

async function resolveEncryptInlineChunked(
  agentLike: any,
  contextGraphId: string,
  publishContextGraphId?: string,
  options?: { aeadBindingContextGraphId?: string },
) {
  agentLike._resolveCuratedChainKeyContext = (DKGAgent.prototype as any)
    ._resolveCuratedChainKeyContext;
  return (DKGAgent.prototype as any)._resolveEncryptInlineChunked.call(
    agentLike,
    contextGraphId,
    undefined,
    undefined,
    publishContextGraphId,
    options,
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

  it('keeps an internally derived same-CG numeric binding id out of LU-5 policy lookup (#1309)', async () => {
    const agentLike = makeAgentLike();
    agentLike.resolveOnChainAccessPolicyState = recorder(async (cgId: string) => {
      if (cgId !== 'sports') {
        throw new Error(`unexpected policy lookup for ${cgId}`);
      }
      return 0;
    });
    agentLike.readLiveOnChainAccessPolicy = recorder(async (id: string) => {
      throw new Error(`raw target probe should not run for derived binding id ${id}`);
    });

    await expect(
      resolveEncryptInlinePayload(agentLike, 'sports', undefined, {
        aeadBindingContextGraphId: '1',
      }),
    ).resolves.toBeUndefined();

    expect(agentLike.resolveOnChainAccessPolicyState.calls[0][0]).toBe('sports');
    expect(agentLike.readLiveOnChainAccessPolicy.calls).toEqual([]);
  });

  it('keeps an internally derived same-CG numeric binding id out of LU-11 policy lookup (#1309)', async () => {
    const agentLike = makeAgentLike();
    agentLike.resolveOnChainAccessPolicyState = recorder(async (cgId: string) => {
      if (cgId !== 'sports') {
        throw new Error(`unexpected policy lookup for ${cgId}`);
      }
      return 0;
    });
    agentLike.readLiveOnChainAccessPolicy = recorder(async (id: string) => {
      throw new Error(`raw target probe should not run for derived binding id ${id}`);
    });

    await expect(
      resolveEncryptInlineChunked(agentLike, 'sports', undefined, {
        aeadBindingContextGraphId: '1',
      }),
    ).resolves.toBeUndefined();

    expect(agentLike.resolveOnChainAccessPolicyState.calls[0][0]).toBe('sports');
    expect(agentLike.readLiveOnChainAccessPolicy.calls).toEqual([]);
  });

  it('uses source policy for same-CG private derived bindings before sender-key bootstrap (#1309)', async () => {
    const agentLike = makeAgentLike();
    agentLike.resolveOnChainAccessPolicyState = recorder(async (cgId: string) => {
      if (cgId !== 'private-cg') {
        throw new Error(`unexpected policy lookup for ${cgId}`);
      }
      return 1;
    });
    agentLike.readLiveOnChainAccessPolicy = recorder(async (id: string) => {
      throw new Error(`raw target probe should not run for derived binding id ${id}`);
    });
    agentLike.loadSwmSenderKeyState = recorder(async () => undefined);
    agentLike.getLocalSigningAgentForAddress = recorder(() => null);
    agentLike.defaultAgentAddress = ethers.Wallet.createRandom().address;
    agentLike.peerId = 'peer-1';

    await expect(
      resolveEncryptInlinePayload(agentLike, 'private-cg', undefined, {
        aeadBindingContextGraphId: '2',
      }),
    ).rejects.toThrow(/cannot bootstrap swm-sender-key/);

    expect(agentLike.resolveOnChainAccessPolicyState.calls[0][0]).toBe('private-cg');
    expect(agentLike.readLiveOnChainAccessPolicy.calls).toEqual([]);
  });

  it('fails closed when a remap target numeric CG policy cannot be resolved', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).rejects.toThrow(
      /target CG "42" curated=unknown/,
    );
  });

  it('LU-11 fails closed when a remap target numeric CG policy cannot be resolved', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlineChunked(agentLike, 'local-public-cg', '42')).rejects.toThrow(
      /LU-11: publish access-policy is unknown/,
    );
    await expect(resolveEncryptInlineChunked(agentLike, 'local-public-cg', '42')).rejects.toThrow(
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

  it('rejects explicit remap when source is curated and numeric target is public', async () => {
    const agentLike = makeAgentLike({ accessPolicy: 0 });
    agentLike.resolveOnChainAccessPolicyState = recorder(async (cgId: string) => {
      if (cgId === 'private-source') return 1;
      throw new Error(`unexpected source lookup for ${cgId}`);
    });

    await expect(resolveEncryptInlinePayload(agentLike, 'private-source', '42')).rejects.toThrow(
      /remap publish source\/target access-policy mismatch/,
    );
  });

  it('rejects explicit remap when source is public and numeric target is curated', async () => {
    const agentLike = makeAgentLike({ accessPolicy: 1 });
    agentLike.resolveOnChainAccessPolicyState = recorder(async (cgId: string) => {
      if (cgId === 'public-source') return 0;
      throw new Error(`unexpected source lookup for ${cgId}`);
    });

    await expect(resolveEncryptInlinePayload(agentLike, 'public-source', '42')).rejects.toThrow(
      /remap publish source\/target access-policy mismatch/,
    );
  });

  it('binds LU-5 AEAD to the resolver-returned binding id, not the local source id', async () => {
    const chainKey = new Uint8Array(32).fill(9);
    const plaintext = new TextEncoder().encode('<urn:s> <urn:p> "o" <urn:g> .');
    const agentLike = {
      _resolveCuratedChainKeyContext: recorder(async () => ({
        chainKey,
        aeadCgId: '1',
        senderAddress: ethers.Wallet.createRandom().address,
      })),
    } as any;

    const encryptInlinePayload = await (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(
      agentLike,
      'sports',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '1' },
    );
    expect(encryptInlinePayload).toBeDefined();

    const encrypted = await encryptInlinePayload(plaintext);
    const recovered = decryptV10PublishPayload({
      chainKey,
      contextGraphId: '1',
      encryptedPayload: encrypted,
    });
    expect(Buffer.from(recovered).equals(Buffer.from(plaintext))).toBe(true);
    expect(() => decryptV10PublishPayload({
      chainKey,
      contextGraphId: 'sports',
      encryptedPayload: encrypted,
    })).toThrow();
    expect(agentLike._resolveCuratedChainKeyContext.calls.at(-1)).toEqual([
      'sports',
      undefined,
      undefined,
      undefined,
      'LU-5',
      { aeadBindingContextGraphId: '1' },
    ]);
  });
});

describe('DKGAgent._publish inline encryption routing', () => {
  it('uses chain-confirmed V2 encryption to attach the catalog when local meta is stale', async () => {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const reservedKaId = (BigInt(authorAddress) << 96n) | 1n;
    const encryptInlinePayload = async (plaintext: Uint8Array) => plaintext;
    const encryptInlineChunked = async () => ({
      ciphertextChunksRoot: new Uint8Array(32),
      ciphertextChunkCount: 1,
      totalCiphertextBytes: 1,
    });
    const publisherPublish = recorder(async () => ({
      status: 'tentative',
      kaId: reservedKaId.toString(),
    }));
    const agentLike = {
      log: {
        info: recorder(() => undefined),
        warn: recorder(() => undefined),
        error: recorder(() => undefined),
        debug: recorder(() => undefined),
      },
      subscribedContextGraphs: new Set(['private-cg']),
      contextGraphExists: recorder(async () => true),
      createV10ACKProvider: recorder(() => undefined),
      getContextGraphOnChainId: recorder(async () => '4'),
      isPrivateContextGraph: recorder(async () => false),
      chain: {
        chainId: 'base:8453',
        isV10Ready: () => true,
        getEvmChainId: async () => 8453n,
        getKnowledgeAssetsLifecycleAddress: async () =>
          '0x2222222222222222222222222222222222222222',
      },
      peerId: 'peer-1',
      publisher: { publish: publisherPublish },
      _buildPrecomputedAttestationForSelection: recorder(async () => ({
        expectedMerkleRoot: new Uint8Array(32),
        authorAddress,
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
        schemeVersion: 1,
        reservedKaId,
      })),
      _resolveEncryptInlinePayload: recorder(async () => encryptInlinePayload),
      _resolveEncryptInlineChunked: recorder(async () => encryptInlineChunked),
      broadcastPublish: recorder(async () => undefined),
      emitPublicProjectionAfterPublish: recorder(async () => undefined),
    } as any;

    await (DKGAgent.prototype as any)._publish.call(
      agentLike,
      'private-cg',
      [{ subject: 'urn:test:s', predicate: 'urn:test:p', object: '"value"', graph: '' }],
    );

    expect(agentLike.isPrivateContextGraph.calls).toEqual([]);
    expect(publisherPublish.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      contextGraphId: 'private-cg',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      encryptInlinePayload,
      encryptInlineChunked,
      trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys('private-cg'),
    }));
  });

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
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'local-cg',
      'sg-a',
      undefined,
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    expect(publisherPublish.calls.at(-1)).toEqual([expect.objectContaining({
      accessPolicy: 'public',
      publisherNodeIdentityIdOverride: 0n,
      encryptInlinePayload,
      encryptInlineChunked,
    })]);
  });

  it('routes direct encrypted private publishes to the publisher without an implicit catalog floor', async () => {
    const encryptInlinePayload = recorder(async (plaintext: Uint8Array) => plaintext);
    const encryptInlineChunked = recorder(() => undefined);
    const publisherError = new Error(
      'Encrypted inline publishes with privateQuads are not supported by the current V10 ACK model.',
    );
    const publisherPublish = recorder(async () => {
      throw publisherError;
    });
    const agentLike = {
      log: {
        info: recorder(() => undefined),
        warn: recorder(() => undefined),
        error: recorder(() => undefined),
        debug: recorder(() => undefined),
      },
      subscribedContextGraphs: new Set(['private-cg']),
      contextGraphExists: recorder(async () => true),
      createV10ACKProvider: recorder(() => undefined),
      getContextGraphOnChainId: recorder(async () => '42'),
      chain: {},
      peerId: 'peer-1',
      publisher: {
        publish: publisherPublish,
      },
      broadcastPublish: recorder(async () => undefined),
      emitPublicProjectionAfterPublish: recorder(async () => undefined),
      _resolveEncryptInlinePayload: recorder(async () => encryptInlinePayload),
      _resolveEncryptInlineChunked: recorder(async () => encryptInlineChunked),
    } as any;

    await expect((DKGAgent.prototype as any)._publish.call(
      agentLike,
      'private-cg',
      [{ subject: 's', predicate: 'p', object: '"public"', graph: 'g' }],
      [{ subject: 's', predicate: 'secret', object: '"private"', graph: 'g' }],
      {
        subGraphName: 'sg-private',
        publisherNodeIdentityIdOverride: 0n,
      },
    )).rejects.toBe(publisherError);

    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'private-cg',
      'sg-private',
      undefined,
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    const publishArgs = publisherPublish.calls.at(-1)?.[0];
    expect(publishArgs).toEqual(expect.objectContaining({
      contextGraphId: 'private-cg',
      privateQuads: [{ subject: 's', predicate: 'secret', object: '"private"', graph: 'g' }],
      publishContextGraphId: '42',
      encryptInlinePayload,
      encryptInlineChunked,
    }));
    expect(publishArgs.trustedNonManifestCatalogTriples).toBeUndefined();
  });

  it('keeps caller-supplied mismatched onChainContextGraphId as an explicit policy target', async () => {
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
      emitPublicProjectionAfterPublish: recorder(async () => undefined),
      _resolveEncryptInlinePayload: recorder(async () => undefined),
      _resolveEncryptInlineChunked: recorder(async () => undefined),
    } as any;

    await (DKGAgent.prototype as any)._publish.call(
      agentLike,
      'local-cg',
      [{ subject: 's', predicate: 'p', object: 'o', graph: 'g' }],
      undefined,
      {
        onChainContextGraphId: '99',
      },
    );

    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'local-cg',
      undefined,
      undefined,
      '99',
      { aeadBindingContextGraphId: '99' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'local-cg',
      undefined,
      undefined,
      '99',
      { aeadBindingContextGraphId: '99' },
    ]);
    expect(publisherPublish.calls.at(-1)).toEqual([expect.objectContaining({
      publishContextGraphId: '99',
    })]);
  });
});

describe('DKGAgent.update inline encryption routing', () => {
  it('passes derived update on-chain id as binding-only while preserving publisher target', async () => {
    const store = new OxigraphStore();
    const chainId = 'mock:31337';
    const author = '0x1111111111111111111111111111111111111111';
    const kaNumber = 123n;
    const kaId = (BigInt(author) << 96n) | kaNumber;
    const ual = `did:dkg:${chainId}/${author}/${kaNumber.toString()}`;
    const currentScope = createGraphKnowledgeAssetScope(ual, 1);
    const metaGraph = contextGraphMetaUri('private-cg');
    const assertionGraph = knowledgeAssetLayerGraphUri(
      'private-cg',
      MemoryLayer.VerifiableMemory,
      currentScope,
    );
    const dkg = 'http://dkg.io/ontology/';
    const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';
    await store.insert([
      { subject: ual, predicate: `${dkg}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${xsdInteger}>`, graph: metaGraph },
      { subject: ual, predicate: `${dkg}kaUal`, object: ual, graph: metaGraph },
      { subject: ual, predicate: `${dkg}assertionVersion`, object: `"1"^^<${xsdInteger}>`, graph: metaGraph },
      { subject: ual, predicate: `${dkg}batchId`, object: `"${kaId.toString()}"^^<${xsdInteger}>`, graph: metaGraph },
      { subject: ual, predicate: `${dkg}status`, object: '"confirmed"', graph: metaGraph },
      { subject: ual, predicate: `${dkg}contextGraph`, object: contextGraphDataUri('private-cg'), graph: metaGraph },
      { subject: ual, predicate: `${dkg}assertionGraph`, object: assertionGraph, graph: metaGraph },
    ]);
    const updateQuads = [{ subject: 'urn:update:subject', predicate: 'urn:update:predicate', object: '"o"', graph: '' }];
    const canonical = await skolemizeKnowledgeAssetParts(updateQuads, []);
    const updateRoot = computeFlatKCRootV10(canonical.publicQuads, []);
    const updateEncryptInlinePayload = async (plaintext: Uint8Array) => plaintext;
    const updateEncryptInlineChunked = async () => ({
      ciphertextChunksRoot: new Uint8Array(32),
      ciphertextChunkCount: 0,
      totalCiphertextBytes: 0,
      ciphertextChunks: [],
    });
    const publisherUpdate = recorder(async () => ({
      status: 'confirmed',
    }));
    const agentLike = {
      store,
      log: {
        info: recorder(() => undefined),
        warn: recorder(() => undefined),
        error: recorder(() => undefined),
        debug: recorder(() => undefined),
      },
      chain: {
        chainId,
        getEvmChainId: recorder(async () => 31337n),
        getKnowledgeAssetsLifecycleAddress: recorder(
          async () => '0x2222222222222222222222222222222222222222',
        ),
        hasContractCode: recorder(async () => true),
        verifyContractSignature: recorder(async () => true),
        getKnowledgeAssetOwner: recorder(async () => author),
      },
      getContextGraphOnChainId: recorder(async () => '42'),
      createV10UpdateACKProvider: recorder(() => undefined),
      node: { peerId: { toString: () => 'peer-1' } },
      publisher: {
        updateKnowledgeAssetFromSharedMemory: publisherUpdate,
      },
      _resolveEncryptInlinePayload: recorder(async () => updateEncryptInlinePayload),
      _resolveEncryptInlineChunked: recorder(async () => updateEncryptInlineChunked),
    } as any;

    await (DKGAgent.prototype as any).update.call(
      agentLike,
      kaId,
      'private-cg',
      updateQuads,
      [],
      {
        precomputedUpdateAttestation: {
          expectedNewMerkleRoot: updateRoot,
          authorAddress: author,
          signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
          schemeVersion: 1,
        },
      },
    );

    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'private-cg',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'private-cg',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    expect(publisherUpdate.calls.at(-1)).toEqual([
      kaId,
      expect.objectContaining({
        publishContextGraphId: '42',
        encryptInlinePayload: updateEncryptInlinePayload,
        encryptInlineChunked: updateEncryptInlineChunked,
      }),
    ]);
  });
});

describe('DKGAgent.publishFromSharedMemory inline encryption routing', () => {
  function makeSwmPublishAgentLike(onChainId = '1') {
    const publisherPublishFromSharedMemory = recorder(async () => ({
      status: 'tentative',
      kaId: '1',
    }));
    return {
      log: {
        info: recorder(() => undefined),
        warn: recorder(() => undefined),
        error: recorder(() => undefined),
        debug: recorder(() => undefined),
      },
      getContextGraphOnChainId: recorder(async () => onChainId),
      createV10ACKProvider: recorder(() => undefined),
      isPrivateContextGraph: recorder(async () => false),
      chain: {},
      _resolveEncryptInlinePayload: recorder(async () => undefined),
      _resolveEncryptInlineChunked: recorder(async () => undefined),
      publisher: {
        publishFromSharedMemory: publisherPublishFromSharedMemory,
      },
    } as any;
  }

  it('passes derived same-CG on-chain id as binding-only and publisher chain target', async () => {
    const agentLike = makeSwmPublishAgentLike('1');

    await (DKGAgent.prototype as any).publishFromSharedMemory.call(agentLike, 'sports', 'all');

    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'sports',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '1' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'sports',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '1' },
    ]);
    expect(agentLike.publisher.publishFromSharedMemory.calls.at(-1)).toEqual([
      'sports',
      'all',
      expect.objectContaining({
        publishContextGraphId: undefined,
        onChainContextGraphId: '1',
      }),
    ]);
  });

  it('passes explicit sub-CG remap id as policy target and binding id', async () => {
    const agentLike = makeSwmPublishAgentLike('should-not-be-used');

    await (DKGAgent.prototype as any).publishFromSharedMemory.call(
      agentLike,
      'sports',
      'all',
      { subContextGraphId: '1' },
    );

    expect(agentLike.getContextGraphOnChainId.calls).toEqual([]);
    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'sports',
      undefined,
      undefined,
      '1',
      { aeadBindingContextGraphId: '1' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'sports',
      undefined,
      undefined,
      '1',
      { aeadBindingContextGraphId: '1' },
    ]);
    expect(agentLike.publisher.publishFromSharedMemory.calls.at(-1)).toEqual([
      'sports',
      'all',
      expect.objectContaining({
        publishContextGraphId: '1',
        onChainContextGraphId: '1',
      }),
    ]);
  });

  it('uses chain-confirmed V2 encryption to attach the catalog when local meta is stale', async () => {
    const agentLike = makeSwmPublishAgentLike('4');
    const encryptInlinePayload = async (plaintext: Uint8Array) => plaintext;
    const encryptInlineChunked = async () => ({
      ciphertextChunksRoot: new Uint8Array(32),
      ciphertextChunkCount: 1,
      totalCiphertextBytes: 1,
    });
    agentLike._resolveEncryptInlinePayload = recorder(async () => encryptInlinePayload);
    agentLike._resolveEncryptInlineChunked = recorder(async () => encryptInlineChunked);

    await (DKGAgent.prototype as any).publishFromSharedMemory.call(
      agentLike,
      '0x37b1Fdfd134e2b17583bCBdD3034F91504cD9C70/TrueSeal',
      'all',
      { contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION },
    );

    expect(agentLike.isPrivateContextGraph.calls).toEqual([]);
    const publishOptions = agentLike.publisher.publishFromSharedMemory.calls.at(-1)?.[2];
    expect(publishOptions).toEqual(expect.objectContaining({
      onChainContextGraphId: '4',
      encryptInlinePayload,
      encryptInlineChunked,
      trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(
        '0x37b1Fdfd134e2b17583bCBdD3034F91504cD9C70/TrueSeal',
      ),
    }));
  });

  it('keeps local-meta catalog mutation for legacy private SWM publishes', async () => {
    const agentLike = makeSwmPublishAgentLike('4');
    agentLike.isPrivateContextGraph = recorder(async () => true);
    agentLike._ensureCuratedCatalogInSwm = recorder(async (
      _contextGraphId: string,
      selection: 'all' | { rootEntities: string[] },
    ) => selection);

    await (DKGAgent.prototype as any).publishFromSharedMemory.call(
      agentLike,
      'private-cg',
      'all',
    );

    expect(agentLike.isPrivateContextGraph.calls).toEqual([['private-cg']]);
    expect(agentLike._ensureCuratedCatalogInSwm.calls.at(-1)?.slice(0, 2)).toEqual([
      'private-cg',
      'all',
    ]);
    expect(agentLike.publisher.publishFromSharedMemory.calls.at(-1)).toEqual([
      'private-cg',
      'all',
      expect.objectContaining({
        onChainContextGraphId: '4',
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys('private-cg'),
      }),
    ]);
  });
});

const QUEUED_TEST_AUTHOR = '0x1111111111111111111111111111111111111111';
const QUEUED_TEST_LIFECYCLE = '0x2222222222222222222222222222222222222222';

function makeQueuedAgentHarness(options: {
  peerId: string;
  ual: string;
  publishStatus?: 'tentative' | 'confirmed';
  chain?: Record<string, unknown>;
  onChainContextGraphId?: string | null;
  encryptInlinePayload?: unknown;
  encryptInlineChunked?: unknown;
}) {
  const publisherPublish = recorder(async (_opts: any) => ({
    status: options.publishStatus ?? 'tentative',
    ual: options.ual,
  }));
  const agentLike: any = {
    peerId: options.peerId,
    defaultAgentAddress: QUEUED_TEST_AUTHOR,
    chain: options.chain ?? {},
    store: {
      query: recorder(async () => ({ type: 'bindings', bindings: [] })),
      insert: recorder(async () => undefined),
      deleteByPattern: recorder(async () => undefined),
    },
    log: {
      info: recorder(() => undefined),
      warn: recorder(() => undefined),
      error: recorder(() => undefined),
      debug: recorder(() => undefined),
    },
    publisher: {
      publish: publisherPublish,
      clearSwmShareComplete: recorder(async () => undefined),
    },
    createV10ACKProvider: recorder(() => undefined),
    _resolveEncryptInlinePayload: recorder(async () => options.encryptInlinePayload),
    _resolveEncryptInlineChunked: recorder(async () => options.encryptInlineChunked),
    _stampPointer: recorder(async () => undefined),
  };
  agentLike.afterConfirmedGraphScopedVmPublishV1 =
    (DKGAgent.prototype as any).afterConfirmedGraphScopedVmPublishV1;
  agentLike.observeRfc64ConfirmedVmV1 =
    (DKGAgent.prototype as any).observeRfc64ConfirmedVmV1;
  agentLike.removeRfc64SwmAuthorInventoryShadowV1 = recorder(async () => ({
    status: 'dormant',
    action: 'remove',
    attempts: 0,
    headObjectDigest: null,
    error: null,
  }));
  if (options.onChainContextGraphId !== undefined) {
    agentLike.getContextGraphOnChainId = recorder(
      async () => options.onChainContextGraphId,
    );
  }
  return { agentLike, publisherPublish };
}

async function makeQueuedPublishRequest(options: {
  contextGraphId: string;
  name: string;
  shareOperationId: string;
  intentByte: string;
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
  privateQuads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
}): Promise<KnowledgeAssetVmPublishRequest> {
  const canonical = await skolemizeKnowledgeAssetParts(
    options.quads.map((quad) => ({ ...quad, graph: '' })),
    (options.privateQuads ?? []).map((quad) => ({ ...quad, graph: '' })),
  );
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  const merkleRoot = ethers.hexlify(computeFlatKCRootV10(
    canonical.publicQuads,
    privateRoot ? [privateRoot] : [],
  ));
  const packedKaId = (BigInt(QUEUED_TEST_AUTHOR) << 96n) | 1n;
  return {
    contextGraphId: options.contextGraphId,
    name: options.name,
    shareOperationId: options.shareOperationId,
    roots: [],
    seal: {
      merkleRoot,
      authorAddress: QUEUED_TEST_AUTHOR,
      signature: {
        r: `0x${'34'.repeat(32)}`,
        vs: `0x${'56'.repeat(32)}`,
      },
      schemeVersion: 1,
      reservedKaId: packedKaId.toString() as `${bigint}`,
    },
    sealChainId: '31337',
    sealKav10Address: QUEUED_TEST_LIFECYCLE,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
    sealMerkleRoot: merkleRoot,
    intentKey: `sha256:${options.intentByte.repeat(32)}`,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:mock:31337/${QUEUED_TEST_AUTHOR}/1`,
    assertionVersion: '1',
    publicTripleCount: canonical.publicQuads.length,
    ...(privateRoot ? { privateMerkleRoot: ethers.hexlify(privateRoot) } : {}),
    privateTripleCount: canonical.privateQuads.length,
  };
}

describe('DKGAgent.publishQueuedKnowledgeAssetVmPublish inline encryption routing', () => {
  it('uses a confirmed queued VM publish only to remove the RFC-64 SWM inventory row', async () => {
    const { agentLike } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-swm-removal',
      ual: 'did:dkg:local/queued-swm-removal',
      publishStatus: 'confirmed',
    });
    const removal = recorder(async () => ({
      status: 'applied',
      action: 'remove',
      attempts: 1,
      headObjectDigest: null,
      error: null,
    }));
    agentLike.removeRfc64SwmAuthorInventoryShadowV1 = removal;
    const catalogAuthoring = recorder(async () => null);
    agentLike.recordRfc64PublicCatalogAssetV1 = catalogAuthoring;
    const snapshotQuads = [{
      subject: 'urn:test:queued-public',
      predicate: 'http://schema.org/name',
      object: '"Queued Public"',
      graph: '',
    }];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'public-cg',
      name: 'queued-public-ka',
      shareOperationId: 'share-op-catalog',
      intentByte: 'ad',
      quads: snapshotQuads,
    });

    await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(
      agentLike,
      request,
      { contextGraphId: request.contextGraphId, quads: snapshotQuads },
    );

    expect(removal.calls).toHaveLength(1);
    expect(removal.calls[0]?.[0]).toMatchObject({
      contextGraphId: 'public-cg',
      seal: {
        authorAddress: QUEUED_TEST_AUTHOR,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      },
    });
    expect(catalogAuthoring.calls).toHaveLength(0);
  });

  it('keeps a confirmed queued VM publish successful when SWM inventory removal fails', async () => {
    const { agentLike } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-swm-removal-failure',
      ual: 'did:dkg:local/queued-swm-removal-failure',
      publishStatus: 'confirmed',
    });
    agentLike.removeRfc64SwmAuthorInventoryShadowV1 = recorder(async () => {
      throw new Error('simulated RFC-64 SWM removal failure');
    });
    const snapshotQuads = [{
      subject: 'urn:test:queued-public-failure',
      predicate: 'http://schema.org/name',
      object: '"Queued Public"',
      graph: '',
    }];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'public-cg',
      name: 'queued-public-ka-failure',
      shareOperationId: 'share-op-catalog-failure',
      intentByte: 'ae',
      quads: snapshotQuads,
    });

    const result = await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(
      agentLike,
      request,
      { contextGraphId: request.contextGraphId, quads: snapshotQuads },
    );

    expect(result).toMatchObject({ status: 'confirmed' });
    expect(agentLike.log.warn.calls.some((call: unknown[]) => (
      String(call[1]).includes('RFC-64 SWM inventory shadow removal')
      && String(call[1]).includes('simulated RFC-64 SWM removal failure')
    ))).toBe(true);
  });

  it('keeps the V2 snapshot exact while passing a detached catalog capability', async () => {
    const realInline = recorder(async (plaintext: Uint8Array) => new Uint8Array([...plaintext, 0xaa]));
    const realChunked = recorder(async () => ({
      ciphertextChunksRoot: ethers.getBytes(ethers.id('queued-real-chunk-root')),
      ciphertextChunkCount: 1,
      totalCiphertextBytes: 1,
    }));
    const failClosedInline = recorder(async () => {
      throw new Error('fail-closed placeholder should not be used');
    });
    const failClosedChunked = recorder(async () => {
      throw new Error('fail-closed chunk placeholder should not be used');
    });
    const { agentLike, publisherPublish } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-encryption',
      ual: 'did:dkg:local/queued-encryption',
      chain: {
        getEvmChainId: recorder(async () => 31337n),
        getKnowledgeAssetsLifecycleAddress: recorder(
          async () => QUEUED_TEST_LIFECYCLE,
        ),
      },
      onChainContextGraphId: '7',
      encryptInlinePayload: realInline,
      encryptInlineChunked: realChunked,
    });
    const generatedFloor = generatedPrivateCatalogFloorQuads('private-cg');
    const legacyFloorQuad = { ...generatedFloor[0], graph: 'urn:legacy:catalog' };
    const snapshotQuads = [
      {
        subject: 'urn:test:queued-private',
        predicate: 'http://schema.org/name',
        object: '"Queued Private"',
        graph: '',
      },
      legacyFloorQuad,
    ];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'private-cg',
      name: 'queued-private-ka',
      shareOperationId: 'share-op-1',
      intentByte: 'ab',
      quads: snapshotQuads,
    });

    await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(agentLike, request, {
      contextGraphId: request.contextGraphId,
      quads: snapshotQuads,
      encryptInlinePayload: failClosedInline,
      encryptInlineChunked: failClosedChunked,
    });

    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'private-cg',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '7' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'private-cg',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '7' },
    ]);
    expect(publisherPublish.calls.at(-1)?.[0]).toMatchObject({
      encryptInlinePayload: realInline,
      encryptInlineChunked: realChunked,
      onChainContextGraphId: '7',
      trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys('private-cg'),
    });
    const publishedQuads = publisherPublish.calls.at(-1)?.[0].quads;
    expect(publishedQuads).toHaveLength(2);
    expect(publishedQuads).toContainEqual({ ...legacyFloorQuad, graph: '' });
    expect([...generatedPrivateCatalogTripleKeys('private-cg')].filter((key) =>
      publishedQuads.some((quad: any) => catalogTripleKey(quad) === key),
    )).toHaveLength(1);
    expect(publisherPublish.calls.at(-1)?.[0].encryptInlinePayload).not.toBe(failClosedInline);
    expect(publisherPublish.calls.at(-1)?.[0].encryptInlineChunked).not.toBe(failClosedChunked);
  });

  it('does not trust or append a catalog floor for a private local-only queued publish', async () => {
    const liveResolverInline = recorder(async (plaintext: Uint8Array) => plaintext);
    const queuedInline = recorder(async (plaintext: Uint8Array) => plaintext);
    const { agentLike, publisherPublish } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-private-local',
      ual: 'did:dkg:local/queued-private-local',
      encryptInlinePayload: liveResolverInline,
    });
    const originalQuads = [{
      subject: 'urn:test:queued-private-local',
      predicate: 'http://schema.org/name',
      object: '"Queued Private Local"',
      graph: '',
    }];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'private-local-cg',
      name: 'queued-private-local-ka',
      shareOperationId: 'share-op-private-local',
      intentByte: 'cd',
      quads: originalQuads,
    });

    await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(
      agentLike,
      request,
      {
        contextGraphId: request.contextGraphId,
        quads: originalQuads,
        encryptInlinePayload: queuedInline,
      },
    );

    expect(publisherPublish.calls.at(-1)?.[0]).toMatchObject({
      quads: originalQuads,
      encryptInlinePayload: queuedInline,
      onChainContextGraphId: undefined,
    });
    expect(publisherPublish.calls.at(-1)?.[0].encryptInlinePayload)
      .not.toBe(liveResolverInline);
    expect(publisherPublish.calls.at(-1)?.[0]).not.toHaveProperty(
      'trustedNonManifestCatalogTriples',
    );
  });

  it('does not trust or append a catalog floor from queued placeholder callbacks', async () => {
    const placeholderInline = recorder(async () => {
      throw new Error('queued fail-closed placeholder');
    });
    const placeholderChunked = recorder(async () => {
      throw new Error('queued fail-closed chunk placeholder');
    });
    const { agentLike, publisherPublish } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-placeholder',
      ual: 'did:dkg:local/queued-placeholder',
    });
    const originalQuads = [{
      subject: 'urn:test:queued-public',
      predicate: 'http://schema.org/name',
      object: '"Queued Public"',
      graph: '',
    }];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'public-cg',
      name: 'queued-public-ka',
      shareOperationId: 'share-op-placeholder',
      intentByte: 'ef',
      quads: originalQuads,
    });

    await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(
      agentLike,
      request,
      {
        contextGraphId: request.contextGraphId,
        quads: originalQuads,
        encryptInlinePayload: placeholderInline,
        encryptInlineChunked: placeholderChunked,
      },
    );

    const publishCall = publisherPublish.calls.at(-1)?.[0];
    expect(publishCall.quads).toEqual(originalQuads);
    expect(publishCall.encryptInlinePayload).toBe(placeholderInline);
    expect(publishCall.encryptInlineChunked).toBe(placeholderChunked);
    expect(publishCall).not.toHaveProperty('trustedNonManifestCatalogTriples');
  });

  it('uses queued resolved on-chain CG id as binding-only metadata for same-CG publishes', async () => {
    const { agentLike, publisherPublish } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-binding',
      ual: 'did:dkg:local/queued-binding',
      chain: {
        getEvmChainId: recorder(async () => 31337n),
        getKnowledgeAssetsLifecycleAddress: recorder(async () => QUEUED_TEST_LIFECYCLE),
      },
      onChainContextGraphId: null,
    });
    const queuedBindingQuads = [{
      subject: 'urn:test:queued-binding',
      predicate: 'http://schema.org/name',
      object: '"Queued Binding"',
      graph: '',
    }];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'memory-layers-e2e',
      name: 'queued-binding-ka',
      shareOperationId: 'share-op-1',
      intentByte: 'cd',
      quads: queuedBindingQuads,
    });

    await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(agentLike, request, {
      contextGraphId: request.contextGraphId,
      quads: queuedBindingQuads,
      publishContextGraphId: '42',
    });

    expect(agentLike.getContextGraphOnChainId.calls).toEqual([
      ['memory-layers-e2e'],
    ]);
    expect(agentLike._resolveEncryptInlinePayload.calls.at(-1)).toEqual([
      'memory-layers-e2e',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    expect(agentLike._resolveEncryptInlineChunked.calls.at(-1)).toEqual([
      'memory-layers-e2e',
      undefined,
      undefined,
      undefined,
      { aeadBindingContextGraphId: '42' },
    ]);
    const publishCall = publisherPublish.calls.at(-1)?.[0];
    expect(publishCall).toMatchObject({
      contextGraphId: 'memory-layers-e2e',
      onChainContextGraphId: '42',
      subGraphName: undefined,
    });
    expect(publishCall).not.toHaveProperty('publishContextGraphId');
  });

  it('fails queued same-CG publishes before publisher execution when the CG is not on chain', async () => {
    const { agentLike, publisherPublish } = makeQueuedAgentHarness({
      peerId: 'did:dkg:agent:queued-unregistered',
      ual: 'did:dkg:local/should-not-publish',
      chain: {
        getEvmChainId: recorder(async () => 31337n),
        getKnowledgeAssetsLifecycleAddress: recorder(async () => QUEUED_TEST_LIFECYCLE),
      },
      onChainContextGraphId: null,
    });
    const unregisteredQuads = [{
      subject: 'urn:test:queued-unregistered',
      predicate: 'http://schema.org/name',
      object: '"Queued Unregistered"',
      graph: '',
    }];
    const request = await makeQueuedPublishRequest({
      contextGraphId: 'unregistered-product-cg',
      name: 'queued-unregistered-ka',
      shareOperationId: 'share-op-1',
      intentByte: 'de',
      quads: unregisteredQuads,
    });

    let thrown: any;
    try {
      await (DKGAgent.prototype as any).publishQueuedKnowledgeAssetVmPublish.call(agentLike, request, {
        contextGraphId: request.contextGraphId,
        quads: unregisteredQuads,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('CG_NOT_REGISTERED');
    expect(String(thrown.message)).toMatch(/not registered on-chain/i);
    expect(publisherPublish.calls).toEqual([]);
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
      ._resolveEncryptInlineChunked.call(
        agentLike,
        'sports',
        undefined,
        undefined,
        undefined,
        { aeadBindingContextGraphId: '42' },
      );
    expect(encryptInlineChunked).toBeDefined();
    expect(agentLike._resolveCuratedChainKeyContext.calls.at(-1)).toEqual([
      'sports',
      undefined,
      undefined,
      undefined,
      'LU-11',
      { aeadBindingContextGraphId: '42' },
    ]);

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
