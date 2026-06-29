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
import type { TxResult, V10PublishingConvictionAccountInfo, ConvictionReader, PcaAccountRelation, ShardingTableNode } from './chain-adapter.js';
import { PcaUnavailableError } from './pca-errors.js';
import { enrichEvmError, getPcaLogicInterface } from './evm-adapter-errors.js';

export class ConvictionMethods extends EVMChainAdapterBase implements ConvictionReader {
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
    if (!this.contracts.dkgPublishingConvictionNFT) {
      // Selector fail-safe: "no PCA contract on this chain" → "no PCA path"
      // (0n), so publishing stays on direct-spend. The discovery path (strict)
      // surfaces it instead, so the daemon answers 503 rather than letting a UI
      // read "unavailable" as "registered nowhere".
      if (opts?.strict) throw new PcaUnavailableError();
      return 0n;
    }
    if (!ethers.isAddress(agent)) return 0n;
    try {
      const id: bigint = await this.readContract(
        this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.agentToAccountId', 'agentToAccountId', agent,
      );
      return BigInt(id);
    } catch (err: any) {
      // `agentToAccountId` is a plain mapping getter — it returns 0 (NOT a
      // revert) for an unregistered address, so a CALL_EXCEPTION here is a real
      // read failure, never a normal "unregistered". The selector fail-safe
      // masks it as 0n (publish at full price, safe); the discovery path
      // (strict) rethrows so a transient blip stays inconclusive instead of
      // flipping a covered wallet to a confirmed "registered nowhere".
      if (err?.code === 'CALL_EXCEPTION' && !opts?.strict) return 0n;
      throw err;
    }
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
        const latestBlock = await this.readProvider('conviction getBlock', (p) => p.getBlock('latest'));
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
    return this.pcaWrite(async () => {
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
    if (!this.contracts.dkgPublishingConvictionNFT) throw new PcaUnavailableError();
    try {
      const t = await this.readContract(
        this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.getAccountInfo', 'getAccountInfo', accountId,
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
            this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.accounts', 'accounts', accountId,
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
            this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.getRemainingAllowance',
            'getRemainingAllowance', accountId, currentEpoch,
          ));
        } catch { /* extended enrichment is best-effort; leave fields undefined */ }
      }
      return info;
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return null;
      throw err;
    }
  }

  async topUpPublishingConvictionAccount(accountId: bigint, amount: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
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
    return this.pcaWrite(async () => {
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
    return this.pcaWrite(async () => {
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
    return this.pcaWrite(async () => {
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

  async isPublishingConvictionAgent(accountId: bigint, agent: string): Promise<boolean> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return false;
    if (!ethers.isAddress(agent)) return false;
    try {
      return Boolean(await this.readContract(
        this.contracts.dkgPublishingConvictionNFT, 'pcaNFT.isAgent', 'isAgent', accountId, agent,
      ));
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return false;
      throw err;
    }
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

  /**
   * GAP-1 — enumerate every PCA the given `wallets` relate to:
   *   - OWNED: the wallet holds the NFT. `DKGPublishingConvictionNFT` is
   *     ERC721Enumerable and tokenId === accountId, so `balanceOf` +
   *     `tokenOfOwnerByIndex` enumerates owned accounts (no `tokensOfOwner`
   *     getter exists — wallet-iteration is the cheapest correct path).
   *   - AGENT: the wallet is a registered publishing agent (`agentToAccountId`,
   *     via the strict GAP-3 lookup).
   * Deduped, relation-tagged (owned/agent/both), sorted by accountId asc.
   *
   * Strict / #9: undeployed NFT throws `PcaUnavailableError` (route → 503); a
   * CALL_EXCEPTION on any read SURFACES (not caught here), so a transient blip
   * becomes a 503, never a partial/empty list a UI would read as "relates to
   * nothing". A healthy read with no matches returns `[]`.
   */
  async listPublishingConvictionAccountsForWallets(wallets: string[]): Promise<PcaAccountRelation[]> {
    await this.init();
    const nft = this.contracts.dkgPublishingConvictionNFT;
    if (!nft) throw new PcaUnavailableError();
    const owned = new Set<bigint>();
    const agent = new Set<bigint>();
    for (const w of wallets) {
      if (!ethers.isAddress(w)) continue;
      const balance: bigint = BigInt(await this.readContract(
        nft, 'pcaNFT.balanceOf', 'balanceOf', w,
      ));
      for (let i = 0n; i < balance; i++) {
        const tokenId: bigint = BigInt(await this.readContract(
          nft, 'pcaNFT.tokenOfOwnerByIndex', 'tokenOfOwnerByIndex', w, i,
        ));
        owned.add(tokenId);
      }
      const acctId = await this.getConvictionAgentAccountId(w, { strict: true });
      if (acctId > 0n) agent.add(acctId);
    }
    const ids = [...new Set<bigint>([...owned, ...agent])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return ids.map((accountId) => {
      const o = owned.has(accountId);
      const g = agent.has(accountId);
      return { accountId, relation: (o && g ? 'both' : o ? 'owned' : 'agent') as PcaAccountRelation['relation'] };
    });
  }

  /** ~30s adapter-side TTL for the B-staked-nodes list. The sharding table
   *  changes slowly and the picker polls it; this is a DEDICATED short TTL, not
   *  the 1h publish-preflight cache. */
  private static readonly DESIGNATABLE_NODES_TTL_MS = 30_000;
  private cachedDesignatableNodes: { value: ShardingTableNode[]; cachedAt: number } | undefined;

  /**
   * B-staked-nodes (Stage-5) — the full sharding table of nodes designatable as
   * a PCA `primaryNode`. Reads the no-arg `ShardingTable.getShardingTable()`,
   * which returns the COMPLETE table: it sizes the read to the live
   * `nodesCount()`, and `shardingTableSizeLimit` is an INSERT-enforced maximum
   * (ShardingTable._insertNode reverts `ShardingTableIsFull` at `nodesCount >=
   * limit`), never a read-truncation cap — so there is nothing to page and no
   * silent node drop. Hash-ring order is preserved; the UI sorts for display.
   *
   * TTL-cached (~30s) adapter-side, success-only (a throw never poisons the
   * cache). Read failures SURFACE — a CALL_EXCEPTION/transport blip propagates
   * to the route (→ 503 SHARDING_TABLE_READ_FAILED / 503-504), never a partial
   * or empty list a picker would misread as "no stakeable nodes".
   *
   * The no-arg overload is resolved via the explicit `getFunction(...)`
   * signature so ethers v6 never confuses it with `getShardingTable(uint72,
   * uint72)`.
   */
  async listDesignatableNodes(): Promise<ShardingTableNode[]> {
    const now = Date.now();
    const cached = this.cachedDesignatableNodes;
    if (cached && now - cached.cachedAt < ConvictionMethods.DESIGNATABLE_NODES_TTL_MS) {
      return cached.value;
    }
    await this.init();
    const shardingTable = await this.resolveContract('ShardingTable');
    const raw = await this.readContractWith<ReadonlyArray<any>>(
      shardingTable,
      'shardingTable.getShardingTable',
      (c) => c.getFunction('getShardingTable()').staticCall(),
    );
    const nodes: ShardingTableNode[] = [];
    for (const n of raw ?? []) {
      const identityId = BigInt(n.identityId ?? n[1]);
      // The no-arg read is sized to nodesCount() so it shouldn't pad, but a
      // zero identityId is never a real node — skip defensively.
      if (identityId <= 0n) continue;
      nodes.push({
        nodeId: String(n.nodeId ?? n[0]),
        identityId,
        ask: BigInt(n.ask ?? n[2]),
        stake: BigInt(n.stake ?? n[3]),
      });
    }
    this.cachedDesignatableNodes = { value: nodes, cachedAt: now };
    return nodes;
  }
}
