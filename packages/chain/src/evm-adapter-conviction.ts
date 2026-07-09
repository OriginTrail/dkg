// SPDX-License-Identifier: Apache-2.0

/**
 * Publishing-conviction account / agent methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers, Contract } from 'ethers';
import type {
  TxResult,
  V10PublishingConvictionAccountInfo,
  NodePublishingConvictionAccount,
  ConvictionReader,
  PcaAccountRelation,
  ShardingTableNode,
  PcaContracts,
  PcaRpcMethod,
} from './chain-adapter.js';
import { PcaUnavailableError } from './pca-errors.js';
import { enrichEvmError, getPcaLogicInterface } from './evm-adapter-errors.js';
import type { PcaMutationInvalidation } from './pca-read-cache.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';
import { ChainRpcTransportError } from './chain-rpc-transport-error.js';

/** Latest-family `eth_getBlockByNumber` block tags that are TIP reads (must stay
 *  preference-transparent). A concrete hex block number or `earliest` is a fixed
 *  block → sticky (prefer the endpoint that already has it). */
const PCA_TIP_BLOCK_TAGS = new Set<string>(['latest', 'pending', 'safe', 'finalized']);

/** Allowlisted PCA proxy methods whose `null` means "this endpoint doesn't have
 *  the object (yet)", not a definitive answer — so a `null` must FAIL OVER to
 *  other endpoints rather than terminate the lookup or reinforce a preference. */
const PCA_NULLABLE_LOOKUP_METHODS = new Set<string>([
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
]);

/** Sentinel: the queried endpoint returned `null` for a nullable PCA lookup — a
 *  retryable "not here" so the failover loop tries the next endpoint. */
class PcaObjectNotFoundError extends Error {
  constructor(method: string) {
    super(`PCA ${method}: object not present on this endpoint`);
    this.name = 'PcaObjectNotFoundError';
  }
}

export interface RawShardingTableNode extends ArrayLike<unknown> {
  nodeId?: unknown;
  identityId?: unknown;
  ask?: unknown;
  stake?: unknown;
}

export function toShardingTableNode(raw: RawShardingTableNode): ShardingTableNode {
  return {
    nodeId: String(raw.nodeId ?? raw[0]),
    identityId: BigInt((raw.identityId ?? raw[1]) as bigint | number | string),
    ask: BigInt((raw.ask ?? raw[2]) as bigint | number | string),
    stake: BigInt((raw.stake ?? raw[3]) as bigint | number | string),
  };
}

export class ConvictionMethods extends EVMChainAdapterBase implements ConvictionReader {
  protected async pcaWriteAndInvalidate<T>(
    invalidation: PcaMutationInvalidation<T>,
    op: () => Promise<T>,
  ): Promise<T> {
    const result = await this.pcaWrite(op);
    this.pcaReadCache.invalidateMutation(invalidation, result);
    return result;
  }

  // =====================================================================
  // Staking + Publishing Conviction Account legacy surface — ARCHIVED
  /**
   * Reverse-resolve a wallet to its V10 PCA account id, or `0n` if the
   * wallet is not registered as a publishing agent. Mirrors the
   * `DKGPublishingConvictionNFT.agentToAccountId(agent)` view.
   *
   * The publisher SDK uses this to decide, BEFORE building a publish
   * tx, whether `KnowledgeAssetsLifecycle.publish()` will route through the
   * PCA discount branch — and therefore whether `publishEpochs` must
   * be coerced to the PCA's `lockDurationEpochs`. Wrong epochs do NOT
   * revert the contract any more; they just demote the publish to
   * direct spend at full price.
   *
   * Returns `0n` (not registered) when the NFT contract is not
   * deployed on this chain, the address is malformed, or the chain
   * call fails — callers treat the unknown case as "no PCA path".
   */
  async getConvictionAgentAccountId(
    agent: string,
    opts?: { strict?: boolean },
  ): Promise<bigint> {
    await this.init();
    const convictionNft = this.contracts.dkgPublishingConvictionNFT;
    if (!convictionNft) {
      // Selector fail-safe: "no PCA contract on this chain" → "no PCA path"
      // (0n), so publishing stays on direct-spend. The discovery path (strict)
      // surfaces it instead, so the daemon answers 503 rather than letting a UI
      // read "unavailable" as "registered nowhere".
      if (opts?.strict) throw new PcaUnavailableError();
      return 0n;
    }
    if (!ethers.isAddress(agent)) return 0n;
    const strict = !!opts?.strict;
    return this.pcaReadCache.getAgentAccountId(agent, strict, async (normalized) => {
      try {
        const id: bigint = await this.readContract(
          convictionNft, 'pcaNFT.agentToAccountId', 'agentToAccountId', normalized,
        );
        return BigInt(id);
      } catch (err: any) {
        // `agentToAccountId` is a plain mapping getter — it returns 0 (NOT a
        // revert) for an unregistered address, so a CALL_EXCEPTION here is a real
        // read failure, never a normal "unregistered". The selector fail-safe
        // masks it as 0n (publish at full price, safe); the discovery path
        // (strict) rethrows so a transient blip stays inconclusive instead of
        // flipping a covered wallet to a confirmed "registered nowhere".
        if (err?.code === 'CALL_EXCEPTION' && !strict) return 0n;
        throw err;
      }
    });
  }

  async getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return 0;
    if (accountId <= 0n) return 0;
    try {
      // `accounts(uint256)` returns, in order:
      //  [0] committedTRAC          [1] createdAtEpoch
      //  [2] expiresAtEpoch         [3] createdAtTimestamp
      //  [4] expiresAtTimestamp     [5] lockDurationEpochs
      //  [6] discountBps            [7] lastSettledWindow
      //  [8] fullySwept             [9] primaryNode (uint72, OT-RFC-51)
      //  [10] lastPrimaryNodeChangeEpoch
      // Pull index 5 for the lock duration. (primaryNode [9] /
      // lastPrimaryNodeChangeEpoch [10] were appended in the RFC-51 bump;
      // `getAccountInfo` does not surface them — GAP-4 reads them here.)
      const tuple = await this.readContract(
        this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.accounts', 'accounts', accountId,
      );
      const lock = tuple[5];
      return Number(lock);
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return 0;
      throw err;
    }
  }

  /**
   * Whether the PCA `accountId` can cover the DISCOUNTED cost of a publish
   * whose undiscounted (base) cost is `baseCost`, right now.
   *
   * Mirrors `PublishingConviction.coverPublishingCost` exactly so the SDK's
   * pre-flight matches the on-chain decision: reject once the account is past
   * its (TIMESTAMP-based) `expiresAtTimestamp`, then apply the account's
   * discount tier (`discountedCost = baseCost * (BPS_DENOMINATOR -
   * discountBps) / BPS_DENOMINATOR`, with the contract's post-discount 1-wei
   * floor), then compare against `getRemainingAllowance(accountId,
   * currentEpoch)` — which folds in the top-up buffer and the current-window
   * spend.
   *
   * The publisher SDK gates the `publishEpochs → lockDurationEpochs`
   * coercion on this: agent registration is consent-free (RFC-001 §3.6) and
   * the contract's conviction branch now falls through to direct spend
   * instead of reverting, so coercing an account that can't actually fund
   * THIS publish would direct-spend at the PCA-lock lifetime AND full price
   * instead of the caller's default. A coarse "balance > 0" check is not
   * enough — a nonzero-but-insufficient account (or a squat funded with a
   * few wei so its base allowance rounds up to ≥1) would still slip through;
   * gating on real coverage of the pending cost closes that.
   *
   * Returns `false` when the NFT is not deployed, the id is non-positive,
   * the account is missing, or the chain call reverts — callers treat the
   * unknown case as "cannot fund", which fails safe to "do not coerce".
   * `baseCost <= 0` is treated as trivially coverable.
   */
  async convictionAccountCanCover(accountId: bigint, baseCost: bigint): Promise<boolean> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return false;
    if (accountId <= 0n) return false;
    if (baseCost <= 0n) return true;
    try {
      const info = await this.getPublishingConvictionAccountInfo(accountId);
      if (!info) return false;

      // Expiry is TIMESTAMP-based on-chain: `coverPublishingCost` reverts
      // `AccountExpired` on `block.timestamp >= expiresAtTimestamp`. The
      // epoch-based `getRemainingAllowance` below still reports allowance
      // during the tail of the expiry epoch (for mid-epoch-created accounts
      // `expiresAtEpoch` rounds up past `expiresAtTimestamp`), so check the
      // wall clock first to mirror the contract exactly — otherwise the SDK
      // would coerce, then fall through to full-price direct spend.
      if (info.expiresAtTimestamp > 0) {
        // TIP-SENSITIVE: `latest` timestamp gates the expiry check; a stale
        // (older) latest from a lagging sticky backend would treat an expired
        // account as still valid → read canonical + preference-transparent.
        const latestBlock = await this.readTipProvider('conviction getBlock', (p) => p.getBlock('latest'));
        const nowTs = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
        if (nowTs >= info.expiresAtTimestamp) return false;
      }

      // Mirror PublishingConviction's discount math + post-discount floor.
      const BPS_DENOMINATOR = 10_000n;
      const discountBps = BigInt(info.discountBps);
      let discountedCost = (baseCost * (BPS_DENOMINATOR - discountBps)) / BPS_DENOMINATOR;
      if (discountedCost === 0n && baseCost > 0n) discountedCost = 1n;

      if (!this.contracts.chronos) {
        this.contracts.chronos = await this.resolveContract('Chronos');
      }
      const currentEpoch: bigint = BigInt(await this.readContract(
        this.contracts.chronos, 'chronos.getCurrentEpoch', 'getCurrentEpoch',
      ));
      const remaining: bigint = await this.readContract(
        this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.getRemainingAllowance',
        'getRemainingAllowance', accountId, currentEpoch,
      );
      return BigInt(remaining) >= discountedCost;
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return false;
      throw err;
    }
  }

  async getPublishingConvictionAccountOwner(accountId: bigint): Promise<string> {
    await this.init();
    const nft = await this.resolveContract('DKGPublishingConvictionNFT');
    const owner = await this.readContract(
      nft, 'pcaNFT.ownerOf', 'ownerOf', accountId,
    );
    return ethers.getAddress(owner);
  }

  requireConvictionNFT(): Contract {
    const nft = this.contracts.dkgPublishingConvictionNFT;
    if (!nft) {
      throw new PcaUnavailableError();
    }
    return nft;
  }

  /**
   * Common wrapper for every PCA (Publisher Conviction Account) write
   * path. Two responsibilities:
   *
   *   1. Opaque "unknown custom error"+data reverts from the post-split
   *      `PublishingConviction` logic contract carry no decoded name
   *      out of ethers — `enrichEvmError` decodes them so the daemon's
   *      error classifier can match downstream (mirrors what
   *      `isContractMissingRevert` does for the resolution path).
   *
   *   2. Self-heal on a stale `DKGPublishingConvictionNFT` /
   *      `PublishingConvictionStorage` binding. Both contracts were
   *      redeployed for v10.0.0-rc.11 (PCA split); the wrapper NFT
   *      lazy-resolves `PublishingConviction` on every call so a
   *      logic rotation is handled on-chain, but a wrapper rotation
   *      surfaces here as `UnauthorizedAccess(Only Contracts in Hub)`
   *      on the FIRST PCA write after the Hub re-registration. The
   *      `withHubStaleRetryAny` outer layer drops every boot-bound
   *      handle, re-runs `init()` to repopulate from the live Hub,
   *      and retries the closure once — `op` re-reads
   *      `this.contracts.dkgPublishingConvictionNFT` via
   *      `requireConvictionNFT()` so the retry uses the new address.
   *
   * NOTE — rc.12 follow-up: other V10 write paths
   * (`createKnowledgeAssets`, `createContextGraph`,
   * `updateKnowledgeCollectionV10`, etc.) should be wrapped with the
   * same self-heal pattern. Tracked in the broader migration to
   * `HubResolutionCache` for every boot-bound contract.
   */
  async pcaWrite<T>(op: () => Promise<T>): Promise<T> {
    return this.withHubStaleRetryAny(async () => {
      try {
        return await op();
      } catch (err) {
        if (err instanceof Error) enrichEvmError(err);
        throw err;
      }
    });
  }

  async createPublishingConvictionAccount(
    committedTRAC: bigint,
    primaryNode: bigint = 0n,
  ): Promise<{ accountId: bigint } & TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'account-created', accountIdFromResult: (result) => result.accountId }, async () => {
      const nft = this.requireConvictionNFT();
      const nftAddress = await nft.getAddress();

      // createAccount() does transferFrom(msg.sender → stakingStorage,
      // committedTRAC) — the signer must allow the NFT to pull the TRAC.
      if (this.contracts.token) {
        const allowance: bigint = await this.readContract(
          this.contracts.token, 'token.allowance', 'allowance', this.signer.address, nftAddress,
        );
        if (allowance < committedTRAC) {
          await this.sendContractTransaction(
            this.contracts.token,
            'approve',
            [nftAddress, ethers.MaxUint256],
            this.signer,
            'approve PCA TRAC',
          );
        }
      }

      const receipt = await this.sendContractTransaction(
        nft,
        'createAccount',
        [committedTRAC, primaryNode],
        this.signer,
        'create publishing conviction account',
      );

      // Post PR #650 split, `AccountCreated` is emitted by
      // `PublishingConviction` (logic), NOT by the wrapper. Parse via
      // the logic ABI so this keeps working once `chain/abi/DKGPublishingConvictionNFT.json`
      // is refreshed to its post-split slim surface (which no longer
      // declares any PCA events).
      const pcaLogic = getPcaLogicInterface();
      let accountId = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = pcaLogic.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'AccountCreated') {
            accountId = BigInt(parsed.args.accountId);
            break;
          }
        } catch { /* not a PublishingConviction event */ }
      }
      if (accountId === 0n) {
        throw new Error('createPublishingConvictionAccount succeeded but no AccountCreated event found');
      }

      return {
        accountId,
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
        success: receipt.status === 1,
      };
    });
  }

  async getPublishingConvictionAccountInfo(
    accountId: bigint,
    opts?: { extended?: boolean },
  ): Promise<V10PublishingConvictionAccountInfo | null> {
    await this.init();
    // Undeployed NFT → capability error (503). null is reserved below
    // for a genuine account-missing revert so the route can disambiguate.
    const convictionNft = this.contracts.dkgPublishingConvictionNFT;
    if (!convictionNft) throw new PcaUnavailableError();
    return this.pcaReadCache.getAccountInfo(accountId, !!opts?.extended, async () => {
      try {
        const t = await this.readContract(
          convictionNft, 'pcaNFT.getAccountInfo', 'getAccountInfo', accountId,
        );
        const info: V10PublishingConvictionAccountInfo = {
          owner: ethers.getAddress(t[0]),
          committedTRAC: BigInt(t[1]),
          baseEpochAllowance: BigInt(t[2]),
          createdAtEpoch: Number(t[3]),
          expiresAtEpoch: Number(t[4]),
          createdAtTimestamp: Number(t[5]),
          expiresAtTimestamp: Number(t[6]),
          discountBps: Number(t[7]),
          topUpBuffer: BigInt(t[8]),
          agentCount: Number(t[9]),
          lastSettledWindow: Number(t[10]),
          fullySwept: Boolean(t[11]),
        };
        // GAP-4/5 (opt-in; the S3 budget widget passes `extended`). The default
        // path (incl. the `convictionAccountCanCover` publish hot path) skips
        // this entirely — zero extra reads. FAIL-SOFT: an extended-read error
        // must NOT null the account (core getAccountInfo already succeeded); the
        // fields are simply left undefined so the UI shows them as unknown
        // (distinct from primaryNode '0' = "no designated node"). primaryNode /
        // lastPrimaryNodeChangeEpoch are `accounts()` [9]/[10] (RFC-51, not in
        // getAccountInfo); remainingAllowance is the current epoch's headroom.
        if (opts?.extended) {
          try {
            const acct = await this.readContract(
              convictionNft, 'pcaNFT.accounts', 'accounts', accountId,
            );
            info.primaryNode = BigInt(acct[9]);
            info.lastPrimaryNodeChangeEpoch = Number(acct[10]);
            if (!this.contracts.chronos) {
              this.contracts.chronos = await this.resolveContract('Chronos');
            }
            const currentEpoch: bigint = BigInt(await this.readContract(
              this.contracts.chronos, 'chronos.getCurrentEpoch', 'getCurrentEpoch',
            ));
            info.currentEpoch = Number(currentEpoch);
            info.remainingAllowance = BigInt(await this.readContract(
              convictionNft, 'pcaNFT.getRemainingAllowance',
              'getRemainingAllowance', accountId, currentEpoch,
            ));
          } catch { /* extended enrichment is best-effort; leave fields undefined */ }
        }
        return info;
      } catch (err: any) {
        if (err?.code === 'CALL_EXCEPTION') {
          return null;
        }
        throw err;
      }
    });
  }

  async topUpPublishingConvictionAccount(accountId: bigint, amount: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'account-changed', accountId }, async () => {
      const nft = this.requireConvictionNFT();
      const nftAddress = await nft.getAddress();
      if (this.contracts.token) {
        const allowance: bigint = await this.readContract(
          this.contracts.token, 'token.allowance', 'allowance', this.signer.address, nftAddress,
        );
        if (allowance < amount) {
          await this.sendContractTransaction(
            this.contracts.token,
            'approve',
            [nftAddress, ethers.MaxUint256],
            this.signer,
            'approve PCA top-up TRAC',
          );
        }
      }
      const receipt = await this.sendContractTransaction(
        nft,
        'topUp',
        [accountId, amount],
        this.signer,
        'top up publishing conviction account',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async settlePublishingConvictionAccount(accountId: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'account-changed', accountId }, async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'settle',
        [accountId],
        this.signer,
        'settle publishing conviction account',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async registerPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'agents-changed', accountId, agents: [agent] }, async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'registerAgent',
        [accountId, agent],
        this.signer,
        'register publishing conviction agent',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async deregisterPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'agents-changed', accountId, agents: [agent] }, async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'deregisterAgent',
        [accountId, agent],
        this.signer,
        'deregister publishing conviction agent',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  /**
   * Bulk-clear EVERY registered agent of a PCA. Owner-gated on-chain (ownerOf
   * == caller). Unlike register/deregister (NFT-wrapper methods), `clearAgents`
   * lives on the PublishingConviction LOGIC contract — the non-upgradeable
   * wrapper has no entry point for it — so resolve the logic directly. Note PCA
   * transfers PRESERVE the allow-list; this is the explicit reset a new owner
   * uses to drop inherited agents.
   */
  async clearPublishingConvictionAgents(accountId: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'all-agents-cleared', accountId }, async () => {
      const logic = await this.resolveContract('PublishingConviction');
      const receipt = await this.sendContractTransaction(
        logic,
        'clearAgents',
        [accountId],
        this.signer,
        'clear publishing conviction agents',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  /**
   * Bulk-register MULTIPLE agents on a PCA in one tx. Owner-gated on-chain
   * (ownerOf == caller). Like clearAgents, `registerAgents` lives on the
   * PublishingConviction LOGIC contract (the frozen NFT wrapper has no batch
   * entry point). All-or-nothing: any invalid entry reverts the whole batch.
   */
  async registerPublishingConvictionAgents(accountId: bigint, agents: string[]): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'agents-changed', accountId, agents }, async () => {
      const logic = await this.resolveContract('PublishingConviction');
      const receipt = await this.sendContractTransaction(
        logic,
        'registerAgents',
        [accountId, agents],
        this.signer,
        'bulk-register publishing conviction agents',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async isPublishingConvictionAgent(accountId: bigint, agent: string): Promise<boolean> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return false;
    if (!ethers.isAddress(agent)) return false;
    // `isAgent` is a pure view that returns false for normal not-approved cases.
    // A CALL_EXCEPTION here is a read failure, not a confirmed negative; callers
    // must surface it as inconclusive so the UI never makes a false coverage claim.
    return Boolean(await this.readContract(
      this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.isAgent', 'isAgent', accountId, agent,
    ));
  }

  /**
   * Addresses + numeric chain id a browser wallet needs to build owner-signed
   * PCA txs client-side (wallet-connect path). The node's RPC URL is
   * deliberately NOT included — the browser signs/reads over the user's own
   * wallet provider, so the node's (possibly tenant-secret) RPC never leaks.
   */
  async getPcaContractContext(): Promise<{
    chainId: number;
    hubAddress: string;
    nftAddress: string;
    tokenAddress: string;
    publishingConvictionAddress: string;
    clearAgentsSupported: boolean;
  }> {
    await this.init();
    const nft = this.requireConvictionNFT();
    const nftAddress = ethers.getAddress(await nft.getAddress());
    if (!this.contracts.token) {
      throw new Error('Token contract not available on this chain');
    }
    const tokenAddress = ethers.getAddress(await this.contracts.token.getAddress());
    // PublishingConviction is the LOGIC contract that owns clearAgents (the NFT
    // wrapper has no entry point for it), so the browser wallet-connect path
    // needs its address to wallet-sign the bulk agent reset.
    const logic = await this.resolveContract('PublishingConviction');
    const publishingConvictionAddress = ethers.getAddress(await logic.getAddress());
    // `clearAgents` lands in PublishingConviction 10.0.6. Gate the UI on the
    // DEPLOYED version so the button only enables once the upgrade is live —
    // self-healing (no node software redeploy needed when the contract is
    // upgraded). Fail closed (unsupported) if the version can't be read.
    let clearAgentsSupported = false;
    try {
      const v = String(await logic.version()).split('.').map((n) => parseInt(n, 10) || 0);
      const [maj, min, pat] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
      clearAgentsSupported = maj > 10 || (maj === 10 && (min > 0 || (min === 0 && pat >= 6)));
    } catch {
      /* unknown / pre-versioned contract → treat as unsupported */
    }
    const chainId = Number(await this.getEvmChainId());
    return {
      chainId,
      hubAddress: ethers.getAddress(this.hubAddress),
      nftAddress,
      tokenAddress,
      publishingConvictionAddress,
      clearAgentsSupported,
    };
  }

  /**
   * OT-RFC-51 designated primary node for a PCA. Reads index 9 of the
   * `accounts(uint256)` tuple
   * `(committedTRAC, createdAtEpoch, expiresAtEpoch, createdAtTimestamp,
   *   expiresAtTimestamp, lockDurationEpochs, discountBps, lastSettledWindow,
   *   fullySwept, primaryNode, lastPrimaryNodeChangeEpoch)`.
   * `getAccountInfo` (used by {@link getPublishingConvictionAccountInfo}) does
   * NOT carry `primaryNode`, so this is a separate read. Returns `0n` when
   * unset, the account is missing, or the NFT is undeployed.
   */
  async getConvictionPrimaryNode(accountId: bigint): Promise<bigint> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return 0n;
    if (accountId <= 0n) return 0n;
    try {
      const tuple = await this.readContract(
        this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.accounts', 'accounts', accountId,
      );
      return BigInt(tuple[9]);
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return 0n;
      throw err;
    }
  }

  /**
   * Enumerate the PCAs owned by the bound operational wallet via the NFT's
   * ERC721Enumerable surface (`balanceOf` + `tokenOfOwnerByIndex`), annotating
   * each with its OT-RFC-51 `primaryNode` association and whether it funds this
   * node's own identity. These are exactly the accounts this wallet can manage
   * (owner-gated writes). Accounts owned by a different wallet that nonetheless
   * fund this node are out of scope here — load those by id via
   * {@link getPublishingConvictionAccountInfo}.
   */
  async listNodePublishingConvictionAccounts(): Promise<NodePublishingConvictionAccount[]> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) throw new PcaUnavailableError();
    const nft = this.requireConvictionNFT();
    const owner = this.signer.address;
    // 0n when this node has no on-chain profile yet — then no PCA "funds this node".
    const myIdentity = await this.getIdentityId();

    const balance: bigint = BigInt(await this.readContract(
      nft, 'pcaNFT.balanceOf', 'balanceOf', owner,
    ));

    const out: NodePublishingConvictionAccount[] = [];
    for (let i = 0n; i < balance; i += 1n) {
      const accountId: bigint = BigInt(await this.readContract(
        nft, 'pcaNFT.tokenOfOwnerByIndex', 'tokenOfOwnerByIndex', owner, i,
      ));
      const info = await this.getPublishingConvictionAccountInfo(accountId);
      if (!info) continue; // raced burn / inconsistent enumeration — skip
      const primaryNode = await this.getConvictionPrimaryNode(accountId);
      out.push({
        accountId,
        primaryNode,
        fundsThisNode: myIdentity !== 0n && primaryNode === myIdentity,
        info,
      });
    }
    // Surface the PCAs that fund this node first.
    out.sort((a, b) => Number(b.fundsThisNode) - Number(a.fundsThisNode));
    return out;
  }

  /**
   * OT-RFC-51 owner-gated re-designation of a PCA's primary node. Moves FUTURE
   * epochs' publishing allocation from the old node to `primaryNode`. The
   * on-chain rate-limit (at most once per epoch) and the owner check surface as
   * reverts that `pcaWrite` → the daemon classifier maps to 409 / 403.
   */
  async setPublishingConvictionPrimaryNode(accountId: bigint, primaryNode: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWriteAndInvalidate({ kind: 'account-changed', accountId }, async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'setPrimaryNode',
        [accountId, primaryNode],
        this.signer,
        'set publishing conviction primary node',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  /**
   * Enumerate every publishing agent (operational wallet) currently
   * registered to `accountId`, mirroring
   * `PublishingConvictionStorage.getRegisteredAgents` (surfaced via the
   * `DKGPublishingConvictionNFT` wrapper). The on-chain view already
   * returns checksummed addresses; normalize defensively so callers (and
   * the daemon's approved-wallet table) always get EIP-55 form.
   *
   * Discovery-only (no funded-wallet-selector caller), so it does NOT
   * fail-safe a read error to `[]`: `getRegisteredAgents` is reached only
   * AFTER the daemon route's existence/capability gate
   * (`getPublishingConvictionAccountInfo`), so a CALL_EXCEPTION here is a real
   * read failure (stale binding / RPC), never a "missing account". Surfacing
   * it lets the route answer 503 — a transient blip must not read as a
   * confirmed empty list ("no approved wallets"), the same #9 honesty rule as
   * the strict GAP-3 lookup. A healthy empty read still returns `[]`. The
   * undeployed / non-positive-id guards are defensive (the route gates both).
   */
  async getPublishingConvictionAgents(accountId: bigint): Promise<string[]> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return [];
    if (accountId <= 0n) return [];
    const raw: string[] = await this.readContract(
      this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.getRegisteredAgents', 'getRegisteredAgents', accountId,
    );
    return (raw ?? []).map((a) => ethers.getAddress(a));
  }

  async listPublishingConvictionAccountsForWallets(wallets: string[]): Promise<PcaAccountRelation[]> {
    await this.init();
    const nft = this.contracts.dkgPublishingConvictionNFT;
    if (!nft) throw new PcaUnavailableError();

    const owned = new Set<bigint>();
    const agent = new Set<bigint>();
    for (const wallet of wallets) {
      if (!ethers.isAddress(wallet)) continue;

      const balance = BigInt(await this.readContract(
        nft, 'pcaNFT.balanceOf', 'balanceOf', wallet,
      ));
      for (let index = 0n; index < balance; index++) {
        const tokenId = BigInt(await this.readContract(
          nft, 'pcaNFT.tokenOfOwnerByIndex', 'tokenOfOwnerByIndex', wallet, index,
        ));
        owned.add(tokenId);
      }

      const accountId = await this.getConvictionAgentAccountId(wallet, { strict: true });
      if (accountId > 0n) agent.add(accountId);
    }

    const ids = [...new Set<bigint>([...owned, ...agent])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return ids.map((accountId) => {
      const isOwned = owned.has(accountId);
      const isAgent = agent.has(accountId);
      return { accountId, relation: isOwned && isAgent ? 'both' : isOwned ? 'owned' : 'agent' };
    });
  }

  private static readonly DESIGNATABLE_NODES_TTL_MS = 30_000;
  private cachedDesignatableNodes: { value: ShardingTableNode[]; cachedAt: number } | undefined;

  async listDesignatableNodes(opts?: { fresh?: boolean }): Promise<ShardingTableNode[]> {
    const now = Date.now();
    const cached = this.cachedDesignatableNodes;
    if (!opts?.fresh && cached && now - cached.cachedAt < ConvictionMethods.DESIGNATABLE_NODES_TTL_MS) {
      return cached.value;
    }

    await this.init();
    const shardingTable = await this.resolveContract('ShardingTable');
    const raw = await this.readContractWith<readonly RawShardingTableNode[]>(
      shardingTable,
      'shardingTable.getShardingTable',
      (contract) => contract.getFunction('getShardingTable()').staticCall(),
    );
    const nodes: ShardingTableNode[] = [];
    for (const item of raw ?? []) {
      const node = toShardingTableNode(item);
      if (node.identityId <= 0n) continue;
      nodes.push(node);
    }
    this.cachedDesignatableNodes = { value: nodes, cachedAt: now };
    return nodes;
  }

  /**
   * Browser bootstrap (sub-PR #2 HW signing) — the minimal resolved contract
   * addresses + chain params the in-browser viem layer needs to submit
   * owner-actions direct-to-contract, in ONE call (no in-browser Hub
   * resolution, H2). Returns `{ nft, token, chainId, rpcUrls }`:
   *   - `nft` = DKGPublishingConvictionNFT (wrapper) — every wallet-signed write
   *     (create/topUp/registerAgent/deregisterAgent) targets it, and it's the
   *     ERC721Enumerable + mint-Transfer source for discovery/accountId parse.
   *   - `token` = the TRAC ERC-20 the approve pre-step allows the wrapper to pull.
   * Both EIP-55 checksummed. `chainId` is returned AS-IS (may be the compound
   * `base:84532` form — the FE extracts the numeric tail for viem's Chain.id).
   * `rpcUrls` contains only configured wallet-public endpoints. The daemon route
   * replaces it with same-origin `/api/pca/rpc` for node-UI browser reads so
   * configured operator RPC URLs/API keys never leave the node process.
   * Undeployed NFT/token → PcaUnavailableError (route → 503), the same
   * capability signal as the other PCA reads. NO Hub/logic/ShardingTable — no
   * browser owner-action touches them.
   */
  async getPublishingConvictionContracts(): Promise<PcaContracts> {
    await this.init();
    const nft = this.requireConvictionNFT();
    const token = this.contracts.token;
    if (!token) throw new PcaUnavailableError();
    return {
      nft: ethers.getAddress(await nft.getAddress()),
      token: ethers.getAddress(await token.getAddress()),
      chainId: this.chainId,
      rpcUrls: [...this.walletRpcUrls],
      walletRpcUrls: [...this.walletRpcUrls],
    };
  }

  async requestPublishingConvictionRpc(method: PcaRpcMethod, params: unknown[] = []): Promise<unknown> {
    await this.init();
    const label = `pca rpc ${method}`;
    const tag = params[0];

    // TRUE tip read (current head, or a latest-family `eth_getBlockByNumber` tag) →
    // preference-TRANSPARENT: a lagging sticky backend would give a stale head.
    const isTipRead = method === 'eth_blockNumber'
      || (method === 'eth_getBlockByNumber' && typeof tag === 'string' && PCA_TIP_BLOCK_TAGS.has(tag));
    if (isTipRead) {
      return this.readTipProvider(label, (provider) => provider.send(method, params));
    }

    // Nullable reconciliation read (receipt / tx / a concrete block) → STICKY
    // (prefer the endpoint that already observed the tx/block), BUT a `null` means
    // "not here yet", not a definitive answer: it must FAIL OVER to the other
    // endpoints (so a lagging preferred backend can't hide an object another has)
    // and must NOT reinforce a preference. Throwing on `null` makes it retryable
    // AND keeps it off the success/establish path; if EVERY endpoint lacks it, the
    // honest `null` is returned.
    const isTipConcreteBlock = method === 'eth_getBlockByNumber'
      && typeof tag === 'string' && PCA_TIP_BLOCK_TAGS.has(tag);
    if (PCA_NULLABLE_LOOKUP_METHODS.has(method) && !isTipConcreteBlock) {
      try {
        return await this.readProvider(
          label,
          async (provider) => {
            const result = await provider.send(method, params);
            if (result == null) throw new PcaObjectNotFoundError(method);
            return result;
          },
          { isRetryable: (e) => e instanceof PcaObjectNotFoundError || isRetryableRpcError(e) },
        );
      } catch (err) {
        if (err instanceof ChainRpcTransportError && err.cause instanceof PcaObjectNotFoundError) {
          return null; // no endpoint has it (yet) — the honest "not found" answer
        }
        throw err;
      }
    }

    // eth_call / eth_chainId — plain sticky (a null-ish result is a valid answer).
    return this.readProvider(label, (provider) => provider.send(method, params));
  }
}
