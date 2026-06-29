// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration + contract-cache shapes for the EVM chain adapter,
 * plus the `formatProviderContext` log-context helper, extracted from
 * evm-adapter.ts. Bodies are a 1:1 move from the original module.
 */
import { Contract } from 'ethers';
import type { ApprovalPolicy } from './chain-adapter.js';

export interface EVMAdapterBaseConfig {
  rpcUrl: string;
  rpcUrls?: string[];
  /** Primary operational wallet key (used for identity registration, staking, etc.) */
  privateKey: string;
  /** Additional operational wallet keys for parallel transaction submission. */
  additionalKeys?: string[];
  hubAddress: string;
  /** Optional TRAC token contract override. When omitted, resolve from Hub.Token. */
  tokenAddress?: string;
  chainId?: string;
  /**
   * TTL (ms) for re-resolving `RandomSampling` / `RandomSamplingStorage`
   * addresses from the Hub. Defaults to 5 minutes. Values `<= 0` are
   * treated as "use default" and intentionally NOT supported as a
   * "disable periodic refresh" mode: even with the Hub event listener
   * and the `Only Contracts in Hub` retry wrapper, a missed event on
   * a read-only path (e.g. `getActiveProofPeriodStatus`,
   * `getNodeChallenge`) would leave the adapter pinned to a stale
   * address until restart, exactly the failure mode this cache exists
   * to prevent. The TTL is a backstop, not the primary refresh
   * mechanism — keep it short enough that a missed rotation
   * self-heals within minutes and the steady-state RPC overhead is
   * still effectively zero.
   */
  randomSamplingHubRefreshMs?: number;
  /**
   * Policy that controls how the V10 publish / update auto-approve sizes
   * its TRAC allowance request. Defaults to {@link DEFAULT_APPROVAL_POLICY}
   * (`per-publish`), preserving the bounded-per-publish behaviour that
   * existed before this field landed. See {@link ApprovalPolicy} for the
   * mode semantics.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * Adapter/SDK-level tuning for the pre-10.0.4 `getMaxKaNumberForAuthor`
   * `KnowledgeAssetCreated` fallback scan: the `eth_getLogs` block-window, in
   * blocks. Default 2,000 — the smallest common provider range cap (e.g. Base
   * Sepolia). Raise it (when constructing the adapter directly) on an RPC that
   * serves larger ranges so the bounded fallback covers an older pre-10.0.4
   * deployment in fewer calls. NOTE: this is an adapter-level option — the
   * daemon/agent node config does not currently forward it. A finite value `>= 1`
   * is floored to an integer (e.g. `10000.5` → `10000`); a non-finite or `< 1`
   * value falls back to the default. Irrelevant for >= 10.0.4 deployments (the
   * O(1) view is used).
   */
  kaHighWaterScanPageSize?: number;
  /**
   * Adapter/SDK-level tuning for the ContextGraphNameRegistry discovery scan:
   * the `eth_getLogs` block-window, in blocks. Default 2,000, matching the
   * smallest common provider cap. A finite value `>= 1` is floored; a
   * non-finite or `< 1` value falls back to the default.
   */
  cgRegistryScanPageSize?: number;
  /**
   * Funding-aware publish wallet selection: minimum NATIVE gas balance (wei) an
   * operational wallet must hold to be PREFERRED when selecting the publish
   * signer. Default `0n` (strictly-positive: a wallet at exactly zero gas is
   * skipped in favour of a funded one). Selection only *prefers* a fundable
   * wallet — when none qualifies it still falls back to the best-funded
   * authorized wallet, so a too-low value is harmless. Raise it to reserve a
   * larger gas buffer.
   */
  minPublisherNativeWei?: bigint;
  /**
   * Funding-aware publish wallet selection: minimum TRAC balance (wei) an
   * operational wallet must hold to be PREFERRED when selecting the publish
   * signer. Default `0n` (strictly-positive), matching the on-chain
   * `V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE`. See `minPublisherNativeWei`.
   */
  minPublisherTracWei?: bigint;
}

export interface EVMAdapterConfig extends EVMAdapterBaseConfig {
  /** Admin wallet key used for profile/key-management transactions. */
  adminPrivateKey?: string;
  /**
   * Documents that this adapter is intentionally running without admin
   * authority. Missing admin keys are still accepted for backwards-compatible
   * publish/read-only usage; admin-only operations fail when invoked.
   */
  allowNoAdminSigner?: boolean;
}

export interface ContractCache {
  hub: Contract;
  identity?: Contract;
  profile?: Contract;
  /**
   * RFC 04 v0.3 — read getRelayCapable and listen for RelayCapabilityUpdated
   * events from here. Profile.sol is the only writer (via onlyContracts) but
   * the storage contract owns both the view surface and the event surface.
   */
  profileStorage?: Contract;
  knowledgeAssets?: Contract;
  knowledgeAssetsStorage?: Contract;
  knowledgeAssetStorage?: Contract;
  staking?: Contract;
  contextGraphNameRegistry?: Contract;
  token?: Contract;
  parametersStorage?: Contract;
  askStorage?: Contract;
  contextGraphs?: Contract;
  contextGraphStorage?: Contract;
  knowledgeAssetsLifecycle?: Contract;
  /** V10 NFT-backed PCA. Backs the PCA write surface + the publisher's
   *  `kcEpochs == lockDurationEpochs` discount check (SDK pre-coerces). */
  dkgPublishingConvictionNFT?: Contract;
  randomSampling?: Contract;
  randomSamplingStorage?: Contract;
  identityStorage?: Contract;
  convictionStakingStorage?: Contract;
  stakingStorage?: Contract;
  /**
   * Epoch oracle used by the update path to compute `remainingEpochs`
   * (`endEpoch - currentEpoch`) when sizing `newTokenAmount` so the
   * daemon's pre-flight matches `KnowledgeAssetsLifecycle._validateTokenAmount`.
   * Without this, byteSize-growth updates revert with `InvalidTokenAmount(1, 0)`
   * because the carry-forward `currentTokenAmount` produces `deltaTokenAmount == 0`.
   * Tracked at issue #831.
   */
  chronos?: Contract;
  /** B-staked-nodes (Stage-5): memoized ShardingTable logic contract — its
   *  address is immutable, so listDesignatableNodes resolves it once instead of
   *  re-hitting the Hub on every TTL-cache miss. */
  shardingTable?: Contract;
}

export function formatProviderContext(config: Pick<EVMAdapterConfig, 'chainId' | 'rpcUrl'>): string {
  let rpcHost: string;
  try {
    const parsed = new URL(config.rpcUrl);
    rpcHost = parsed.host || parsed.protocol || 'unknown-rpc';
  } catch {
    rpcHost = 'unparseable-rpc';
  }
  return `chainId=${config.chainId ?? 'unknown'} rpc=${rpcHost}`;
}
