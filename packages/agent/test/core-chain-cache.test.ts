import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { createOperationContext, ed25519Sign } from '@origintrail-official/dkg-core';
import { verifyCacheProof, cacheProofPayload, type CoreChainCacheChallenge } from '../src/core-chain-cache-proof.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, type CoreChainCacheNetwork } from '../src/core-chain-cache-config.js';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';
import { createNetworkAdmissionRouterPolicy } from '../src/p2p/network-admission-protocol-adapter.js';
import { signNetworkIdentityResponse } from '../src/p2p/network-identity-proof.js';
import { normalizePublicSnapshotSyncOptions } from '../src/public-snapshot-options.js';

const remote = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const self = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const seed = Buffer.from('vHxcSg3ecwP9UfJWdmlnWQeJe83jD2yKtOJlWuLpIrTRh3QiB5sL6iRhAidCZ3bHQLaE0RwBfHBNEmV7ylcjqg==', 'base64').subarray(0, 32);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const c: CoreChainCacheChallenge = { version: 1, nonce: 'a'.repeat(64), requesterPeerId: self,
  responderPeerId: remote, chainId: 'base:8453', deploymentId: 'base:8453:hub=data', contextGraphId: 'public', onChainId: '14' };

describe('DKG Core chain cache authentication', () => {
  it('accepts another registration chain, keeps both checks, and rejects replay or an unconfigured deployment', async () => {
    const wallet = ethers.Wallet.createRandom();
    const p = { chainId: 'gnosis:100', deploymentId: 'gnosis:100:hub=registration', identityId: '7' };
    let registered = true;
    const verify = vi.fn(async (signer: string, id: bigint) => registered && signer === wallet.address && id === 7n);
    const networks = [{ identity: { chainId: p.chainId }, relays: [], registry: { ...p, verifyACKIdentity: verify } }] as unknown as CoreChainCacheNetwork[];
    const bytes = encode({ ...p, signature: await wallet.signMessage(cacheProofPayload(c, p)) });
    const signal = new AbortController().signal;
    expect(await verifyCacheProof(bytes, c, networks, signal)).toBe(true);
    expect(verify).toHaveBeenCalledWith(wallet.address, 7n, { signal });
    for (const patch of [{ nonce: 'b'.repeat(64) }, { chainId: 'base:84532' }, { deploymentId: 'other' },
      { onChainId: '15' }, { contextGraphId: 'private' }, { requesterPeerId: remote }, { responderPeerId: self }])
      expect(await verifyCacheProof(bytes, { ...c, ...patch }, networks, signal)).toBe(false);
    expect(await verifyCacheProof(bytes, c, [], signal)).toBe(false);
    registered = false;
    expect(await verifyCacheProof(bytes, c, networks, signal)).toBe(false);
    const aborted = AbortSignal.abort();
    await expect(verifyCacheProof(bytes, c, networks, aborted)).rejects.toThrow();
  });

  it('preserves the opt-in policy and rejects mixing it with explicit peers', () => {
    const job = { contextGraphId: 'public', onChainId: '14', sourcePolicy: 'DKG_Core_chain_cache', trustedCorePeerIds: [] };
    expect(normalizePublicSnapshotSyncOptions(job).sourcePolicy).toBe('DKG_Core_chain_cache');
    expect(() => normalizePublicSnapshotSyncOptions({ ...job, trustedCorePeerIds: [remote] })).toThrow();
  });
});

describe('cross-network chain cache admission', () => {
  it.each(['mainnet', 'testnet'])('permits only cache protocols for a proven foreign %s network', async environment => {
    const own = { networkId: `${environment}-a`, genesisId: `${environment}-a`, chainId: 'base:1' };
    const foreign = { networkId: `${environment}-b`, genesisId: `${environment}-b`, chainId: 'gnosis:2' };
    const close = vi.fn();
    let claimed = foreign;
    let now = Date.now();
    const coordinator = new NetworkAdmissionCoordinator({
      admission: new NetworkAdmissionService({ networkId: own.networkId, selfPeerId: self, now: () => now }), identity: own,
      cacheIdentities: [own, foreign], selfPeerId: self, sign: async () => new Uint8Array(),
      sendIdentityProbe: async (_peer, data) => encode(await signNetworkIdentityResponse({
        request: JSON.parse(new TextDecoder().decode(data)), identity: claimed, responderPeerId: remote,
        sign: payload => ed25519Sign(payload, seed),
      })),
      getConnections: () => [{ remotePeer: { toString: () => remote }, close, abort: vi.fn() }],
      deletePeerFromPeerStore: async () => {},
    });
    const policy = createNetworkAdmissionRouterPolicy(coordinator);
    for (const protocol of [CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL])
      expect(await policy.isPeerAccepted(remote, protocol, 'outbound')).toBe(true);
    for (const protocol of ['/dkg/publish/1', '/dkg/private/1', '/dkg/10.0.0/public-graph-snapshot/1'])
      expect(await policy.isPeerAccepted(remote, protocol, 'inbound')).toBe(false);
    expect(coordinator.verifiedSameNetworkPeerIds().has(remote)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    // Re-probing after cache expiry must reject a switch to a different environment.
    now += 31_000;
    try {
      claimed = { ...foreign, networkId: `other-${environment}`, genesisId: `other-${environment}` };
      expect(await coordinator.ensureCacheAdmitted(remote, createOperationContext('connect'))).toBe(false);
      expect(close).toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});
