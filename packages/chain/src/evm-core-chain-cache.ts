// SPDX-License-Identifier: Apache-2.0
import { createRpcUsageRecorder } from './rpc-usage.js';
import { Contract, ethers, type JsonRpcProvider } from 'ethers';
import { createRpcRequestProvider, withRpcRequestContext, type RpcRequestAdmission } from './rpc-request-transport.js';
import { loadAbi } from './evm-adapter-abi.js';
import { readFirstProviderWithTransientRetry } from './rpc-provider-fallback.js';
import { isContractViewRetryable } from './rpc-failover-client.js';
import { readEvmPublicGraphSnapshot } from './evm-adapter-public-graph-snapshot.js';
import { OPERATIONAL_KEY_PURPOSE } from './evm-adapter-constants.js';
import { numericChainIdOf } from './configured-chain-id.js';
import type { CoreChainCacheRegistry } from './core-chain-cache-registry.js';

/** Wallet-free, lazy RPC reader. It never starts a chain index, sends transactions or signs. */
export function createEvmCoreChainCacheRegistry(config: {
  chainId: string; hubAddress: string; rpcUrls: readonly string[]; finalityConfirmations: number;
  admission?: RpcRequestAdmission;
}): CoreChainCacheRegistry {
  config = Object.freeze({ ...config, rpcUrls: Object.freeze([...config.rpcUrls]) });
  const numeric = numericChainIdOf(config.chainId);
  if (numeric === undefined || numeric > BigInt(Number.MAX_SAFE_INTEGER) || !ethers.isAddress(config.hubAddress)
    || config.hubAddress === ethers.ZeroAddress || !config.rpcUrls.length
    || config.rpcUrls.length > 8 || !Number.isSafeInteger(config.finalityConfirmations) || config.finalityConfirmations < 1)
    throw new Error('Invalid DKG Core chain cache registry');
  const deploymentId = `${config.chainId}:hub=${config.hubAddress.toLowerCase()}`;
  const counts: Record<string, number> = {};
  const accounting = createRpcUsageRecorder(() => config.chainId, "other");
  let ownedProviders: JsonRpcProvider[] | undefined;
  const providers = () => ownedProviders ??= config.rpcUrls.map((url, endpointSlot) => createRpcRequestProvider(url, {
    admission: config.admission, endpointSlot, network: ethers.Network.from(numeric),
    providerOptions: { cacheTimeout: -1, batchMaxCount: 1 },
    onRequest: (method, slot) => { accounting.record(method, slot); counts[method] = (counts[method] ?? 0) + 1; },
  }));
  return {
    chainId: config.chainId, deploymentId,
    verifyACKIdentity: (signer, identityId, options = {}) => withRpcRequestContext({ signal: options.signal }, async () => {
      options.signal?.throwIfAborted();
      if (identityId <= 0n || identityId >= 2n ** 72n || !ethers.isAddress(signer)) return false;
      const valid = await readFirstProviderWithTransientRetry(providers(), async (provider, signal) => {
        // Resolve both registries afresh: a Hub rotation must never leave a revoked key trusted.
        if (BigInt(await provider.send('eth_chainId', [])) !== numeric) throw new Error('Registry RPC chain mismatch');
        const hub = new Contract(config.hubAddress, loadAbi('Hub'), provider);
        const address = async (name: string) => {
          const value: string = await hub.getContractAddress(name);
          if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error('DKG registry unavailable');
          signal.throwIfAborted();
          return value;
        };
        const identity = new Contract(await address('IdentityStorage'), loadAbi('IdentityStorage'), provider);
        const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [signer]));
        if (!await identity.keyHasPurpose(identityId, keyHash, OPERATIONAL_KEY_PURPOSE)) return false;
        signal.throwIfAborted();
        const table = new Contract(await address('ShardingTableStorage'), loadAbi('ShardingTableStorage'), provider);
        const active: boolean = await table.nodeExists(identityId);
        signal.throwIfAborted();
        return active;
      }, { signal: options.signal, retryDelayMs: 250, isRetryable: isContractViewRetryable, awaitPhysicalSettlement: true });
      options.signal?.throwIfAborted();
      return valid === true;
    }),
    readPublicGraphSnapshot: (graph, onChainId, options) => withRpcRequestContext({ signal: options.signal }, () =>
      readEvmPublicGraphSnapshot({ ...config, deploymentId, providers: providers() }, graph, onChainId, options)),
    drainRpcUsage: () => accounting.drainRpcUsage(),
    rpcUsage: () => Object.freeze({ ...counts }),
    destroy: () => { for (const provider of ownedProviders ?? []) provider.destroy(); ownedProviders = undefined; },
  };
}
