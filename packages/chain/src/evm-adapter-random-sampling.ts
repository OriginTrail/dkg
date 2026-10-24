// SPDX-License-Identifier: Apache-2.0

/**
 * Random-sampling challenge / proof methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers } from 'ethers';
import { NoEligibleContextGraphError, NoEligibleKnowledgeCollectionError, ChallengeNoLongerActiveError, MerkleRootMismatchError } from './chain-adapter.js';
import type { NodeChallenge, CreateChallengeResult, TxResult, ProofPeriodStatus } from './chain-adapter.js';
import { enrichEvmError } from './evm-adapter-errors.js';
import { withTimeout } from './evm-adapter-rpc.js';
import type { EVMChainAdapter } from './evm-adapter.js';
import { RandomSamplingContractsUnavailableError, type RandomSamplingAvailability } from './random-sampling-availability.js';
import { HubContractNotFoundError } from './hub-contract-not-found-error.js';
import { MAX_PROBE_AGE_MS, DURATION_PROBE_TIMEOUT_MS } from './evm-adapter-constants.js';
import type { GasLimitBufferOptions } from './gas-limit-buffer.js';

/**
 * Gas headroom for `createChallenge`.
 *
 * The contract draws a context graph by weight and then up to ten of its
 * assets. When none of them is live it settles that graph's weight, sets the
 * graph aside and draws again, up to five graphs per call. Which graphs a call
 * lands on follows from the block it runs in, so the estimate (latest block)
 * and the transaction (a later block) take independent draws. A settle is a
 * fixed amount of work, not a share of the estimate: it walks every epoch
 * since the graph was last finalized and rewrites the graph's path in the
 * weight tree.
 *
 * Measured on a test network with about 630 graphs: a creation without a
 * settle needs 308k to 391k gas and each settle adds 180k to 800k. Of 5,336
 * creations in 24 days, 14% were estimated on a draw with a settle in it.
 * +50% of an estimate without a settle is about 165k, less than the cheapest
 * settle, and 10% of those creations ran out of gas. A creation that runs
 * out rolls its settles back with it, so the same graph is missed again
 * later.
 *
 * 2.5M fits four settles of the usual size (560k) or three of the costliest,
 * and puts every limit (2.8M at least) above the costliest of those 5,336
 * estimates (2.58M). A multiplier with the same reach would be x8 and ask
 * for 20M gas on that estimate, more than a 17M block holds. The +50% is
 * kept for an estimate above 5M, where it is the larger of the two.
 *
 * Unused gas is refunded. The wallet must hold the limit times the fee cap
 * before the transaction is accepted: about 2.8M gas where it was 0.5M.
 */
const CREATE_CHALLENGE_GAS_BUFFER: GasLimitBufferOptions = Object.freeze({
  gasLimitBufferBps: 5_000,
  gasLimitMinBuffer: 2_500_000n,
});

export class RandomSamplingMethods extends EVMChainAdapterBase {
  async resolveRandomSamplingAvailability(this: EVMChainAdapter, identityId: bigint): Promise<RandomSamplingAvailability> {
    try {
      await this.init();
      await this.getRandomSampling();
      const contextReader = this.getRandomSamplingReadContextReader();
      const bindingId = contextReader.getRandomSamplingBindingId();
      const hubGeneration = this.hubBindingGeneration;
      const shardingTableStorage = await this.resolveContract('ShardingTableStorage');
      const shardingTableAddress = this.contractBindingAddress(shardingTableStorage);
      if (
        shardingTableAddress === undefined
        || this.hubBindingGeneration !== hubGeneration
      ) throw new Error('ShardingTableStorage binding changed during eligibility lookup');
      const observed = this.randomSamplingEligibilityObservation;
      if (
        bindingId !== undefined
        && observed?.identityId === identityId
        && observed.bindingId === bindingId
        && observed.shardingTableAddress === shardingTableAddress
        && observed.hubGeneration === hubGeneration
        && Date.now() - observed.checkedAtMs
          < EVMChainAdapterBase.RANDOM_SAMPLING_ELIGIBILITY_MAX_REUSE_MS
        && contextReader.isRandomSamplingBindingCurrent(bindingId)
      ) {
        return { kind: 'available', member: true };
      }
      const member = await this.readRandomSamplingLifecycleMembership(
        shardingTableStorage,
        identityId,
      );
      const currentShardingTableStorage = await this.resolveContract('ShardingTableStorage');
      if (
        bindingId === undefined
        || this.hubBindingGeneration !== hubGeneration
        || this.contractBindingAddress(currentShardingTableStorage) !== shardingTableAddress
        || !contextReader.isRandomSamplingBindingCurrent(bindingId)
      ) {
        this.randomSamplingEligibilityObservation = undefined;
        throw new Error('Random Sampling eligibility bindings changed during lookup');
      }
      this.randomSamplingEligibilityObservation = member
        ? Object.freeze({
            bindingId,
            identityId,
            shardingTableAddress,
            hubGeneration,
            checkedAtMs: Date.now(),
          })
        : undefined;
      return { kind: 'available', member };
    } catch (error) {
      if (error instanceof RandomSamplingContractsUnavailableError
        || (error instanceof HubContractNotFoundError && (
          error.contractName === 'RandomSampling'
          || error.contractName === 'RandomSamplingStorage'
          || error.contractName === 'ShardingTableStorage'
        ))) {
        return { kind: 'unavailable', reason: 'contracts_not_deployed' };
      }
      return { kind: 'indeterminate', error };
    }
  }

  /**
   * Map a caught chain error onto a typed prover error when the revert
   * matches one of the documented retry-next-period / non-retryable
   * conditions; otherwise rethrow the original. Centralised so the
   * three call sites stay in sync with the on-chain revert wording.
   *
   * Note: `createChallenge` reverts via custom errors (decoded by the
   * `getErrorInterface()` helper above), `submitProof` uses
   * `revert("...")` strings for the period/proof-mismatch cases plus a
   * `MerkleRootMismatchError` custom error.
   */
  translateRandomSamplingError(err: unknown): never {
    if (!(err instanceof Error)) throw err;
    enrichEvmError(err);
    const msg = err.message;
    if (msg.includes('NoEligibleContextGraph')) throw new NoEligibleContextGraphError();
    if (msg.includes('NoEligibleKnowledgeAsset')) throw new NoEligibleKnowledgeCollectionError();
    if (msg.includes('This challenge is no longer active')) throw new ChallengeNoLongerActiveError();
    const merkleMatch = msg.match(/MerkleRootMismatchError\((0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+)\)/);
    if (merkleMatch) {
      throw new MerkleRootMismatchError(merkleMatch[1], merkleMatch[2]);
    }
    throw err;
  }

  /**
   * Convert the on-chain `Challenge` tuple (or struct) into our wire
   * type. The contract returns an all-zero struct when no challenge
   * exists for an identity, which we surface as `null` so callers
   * don't have to dispatch on `kaId === 0n`.
   */
  toNodeChallenge(raw: any): NodeChallenge | null {
    const kaId = BigInt(raw.knowledgeAssetId ?? raw[0]);
    const startBlock = BigInt(raw.activeProofPeriodStartBlock ?? raw[4]);
    if (kaId === 0n && startBlock === 0n) return null;
    // OT-RFC-49 — tuple grew two pinned fields (challengeLeafCount @8,
    // challengeRoot @9) after isCurated @7; ethers.getBytes normalises the
    // bytes32 root to the Uint8Array the prover/proof-builder consume.
    const rootRaw = raw.challengeRoot ?? raw[9] ?? ethers.ZeroHash;
    return {
      knowledgeAssetId: kaId,
      chunkId: BigInt(raw.chunkId ?? raw[1]),
      knowledgeAssetStorageContract: String(raw.knowledgeAssetStorageContract ?? raw[2]),
      epoch: BigInt(raw.epoch ?? raw[3]),
      activeProofPeriodStartBlock: startBlock,
      proofingPeriodDurationInBlocks: BigInt(raw.proofingPeriodDurationInBlocks ?? raw[5]),
      solved: Boolean(raw.solved ?? raw[6]),
      isCurated: Boolean(raw.isCurated ?? raw[7]),
      challengeLeafCount: BigInt(raw.challengeLeafCount ?? raw[8] ?? 0n),
      challengeRoot: ethers.getBytes(rootRaw),
    };
  }

  /**
   * Send an RS write (createChallenge / submitProof) through a rotation-selected
   * REGISTERED operational wallet, with a self-heal for STALE eligibility. If
   * the chosen wallet reverts `ProfileDoesntExist` — its operational key was
   * removed out-of-band (a second instance sharing the identity, or a direct
   * admin `removeKey` tx), so this process's `registeredOperationalAddresses`
   * set is stale and the wallet now resolves to identity 0 on-chain — evict it
   * from the set, drop its cached identityId, and retry ONCE on the primary
   * signer (pool[0], the always-registered identity anchor). The revert is a
   * pre-state-change modifier check (`RandomSampling.sol` `profileExists`), so
   * the retry is idempotent. Best-effort: if the revert does not decode, this
   * is a no-op and the original error propagates unchanged — never worse than
   * the pre-rotation pinning.
   */
  protected async sendRandomSamplingTx(
    contract: ethers.Contract,
    method: string,
    args: readonly unknown[],
    label: string,
    opts?: GasLimitBufferOptions,
  ): Promise<ethers.TransactionReceipt> {
    const signer = await this.nextRandomSamplingSigner();
    try {
      return await this.sendContractTransaction(contract, method, args, signer, label, opts);
    } catch (err) {
      if (
        signer.address.toLowerCase() !== this.signer.address.toLowerCase() &&
        enrichEvmError(err) === 'ProfileDoesntExist'
      ) {
        this.registeredOperationalAddresses.delete(signer.address.toLowerCase());
        this.clearIdentityIdForAddress(signer.address);
        return this.sendContractTransaction(contract, method, args, this.signer, label, opts);
      }
      throw err;
    }
  }

  async createChallenge(): Promise<CreateChallengeResult> {
    await this.init();

    return this.withHubStaleRetry(async () => {
      const { rs, rss } = await this.getRandomSampling();

      // Rotate across registered operational wallets (native-only, prefer idle,
      // self-healing on a stale-eligibility revert) instead of pinning wallet #0
      // — the score accrues to the node identity regardless of which registered
      // wallet signs (getIdentityId(msg.sender)).
      let receipt: ethers.TransactionReceipt;
      try {
        receipt = await this.sendRandomSamplingTx(
          rs,
          'createChallenge',
          [],
          'create random-sampling challenge',
          CREATE_CHALLENGE_GAS_BUFFER,
        );
      } catch (err) {
        this.translateRandomSamplingError(err);
      }

      // Decode `ChallengeGenerated(identityId, contextGraphId, kaId, chunkId, epoch, startBlock)`
      // from the receipt. cgId is indexed (topic[2]); the rest are in data
      // but we only need cgId here — the proof builder reads kaId/chunkId
      // off the Challenge struct fetched below, so everything stays
      // consistent if the storage layout shifts.
      let contextGraphId = 0n;
      let challengeIdentityId: bigint | undefined;
      const rsIface = rs.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = rsIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'ChallengeGenerated') {
            challengeIdentityId = BigInt(parsed.args.identityId ?? parsed.args[0]);
            contextGraphId = BigInt(parsed.args.contextGraphId);
            break;
          }
        } catch { /* not this contract */ }
      }
      if (contextGraphId === 0n || challengeIdentityId == null) {
        // The picker only emits the event when it actually lands on a CG,
        // so a missing event is a bug — fail loud rather than fall back
        // to "lookup by KC" which V10 doesn't support natively.
        throw new Error(
          'createChallenge succeeded on-chain but no ChallengeGenerated event was found in the receipt; ' +
          'cannot route proof builder without identityId and contextGraphId.',
        );
      }

      const challengeRaw = await this.readContract(
        rss, 'rss.getNodeChallenge', 'getNodeChallenge', challengeIdentityId,
      );
      const challenge = this.toNodeChallenge(challengeRaw);
      if (!challenge) {
        throw new Error(
          `createChallenge succeeded but RandomSamplingStorage.getNodeChallenge(${challengeIdentityId}) ` +
          'returned an empty struct. This indicates a state inconsistency between ' +
          'RandomSampling and RandomSamplingStorage.',
        );
      }

      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
        success: true,
        challenge,
        contextGraphId,
      };
    });
  }

  async submitProof(content: Uint8Array | `0x${string}`, merkleProof: Uint8Array[]): Promise<TxResult> {
    await this.init();

    // CONTENT-BINDING: the contract now takes the raw content (`bytes`) and
    // derives `leaf = keccak256(content)` on-chain. No 32-byte guard — content
    // is the public N-Triple / curated `_catalog` triple bytes of arbitrary length.
    const contentHex = typeof content === 'string' ? content : ethers.hexlify(content);
    const proofHex = merkleProof.map((p) => ethers.hexlify(p));

    return this.withHubStaleRetry(async () => {
      const { rs } = await this.getRandomSampling();

      // Same identity-scoped rotation as createChallenge (self-healing on a
      // stale-eligibility revert): submitProof may be signed by a different
      // registered wallet than the one that created the challenge — the on-chain
      // challenge slot is keyed by identity, not signer.
      let receipt: ethers.TransactionReceipt;
      try {
        receipt = await this.sendRandomSamplingTx(
          rs,
          'submitProof',
          [contentHex, proofHex],
          'submit random-sampling proof',
          // submitProof's gas depends on `block.timestamp`. The contract settles
          // the node's stake to it and skips that settle when the node is
          // already settled at that timestamp, which createChallenge leaves
          // true for its own block. An estimate that runs on the block holding
          // this node's challenge therefore misses the settle, and the proof,
          // mined a block later, pays for it: observed 294,443 estimated and
          // 306,807 needed (+4.2%); with the raw estimate as its limit the
          // proof ran out of gas and reverted with empty `0x` data. Rarer and
          // larger: a proof mined after an epoch change or a stake-boost expiry
          // writes storage its estimate did not see (measured on a local chain:
          // +33%, +16%, and +46% for both at once). +50%, the headroom
          // createChallenge already has, covers all of these; +25% does not
          // cover the epoch change. Unused gas is refunded.
          { gasLimitBufferBps: 5_000 },
        );
      } catch (err) {
        this.translateRandomSamplingError(err);
      }

      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
        success: true,
      };
    });
  }

  async getActiveProofPeriodStatus(): Promise<ProofPeriodStatus> {
    await this.init();
    const { rs } = await this.getRandomSampling();

    // Codex round 2 on PR #369: the cached `NodeChallenge.proofingPeriodDurationInBlocks`
    // is whatever the contract used at challenge-creation time. The chain's
    // `updateAndGetActiveProofPeriodStartBlock()` rolls forward using the
    // CURRENT epoch's duration via `getActiveProofingPeriodDurationInBlocks()`.
    // If a governance change shortens the duration mid-flight, off-chain
    // staleness checks against the cached duration would underestimate
    // expiry and re-deadlock at the rollover boundary. Pull the live
    // duration alongside the status read so the prover can compare
    // wall-clock against the same value the contract uses for rollover.
    //
    // Codex round 3 + 4 + 5 — keep the live-duration read STRICTLY best-effort:
    // a transient RPC blip, partial rollout, or an older RS deployment
    // that omits the method from its ABI must NOT make the whole
    // `getActiveProofPeriodStatus()` reject OR stall.
    //
    // Naive `Promise.allSettled` is NOT enough —
    // `rs.getActiveProofingPeriodDurationInBlocks()` would throw
    // synchronously (`TypeError: ... is not a function`) before
    // `allSettled` can wrap it when the method is missing entirely.
    //
    // Plain `try/catch` is also NOT enough — a hung RPC (provider
    // accepts the request but never responds) keeps the await pending
    // forever, blocking the entire status probe even though the
    // primary `getActiveProofPeriodStatus()` already returned. The
    // prover can safely continue with the cached challenge duration,
    // so race the duration read against a short timeout and prefer
    // `undefined` on slow paths. The prover treats `undefined` as
    // "fall back to existing.proofingPeriodDurationInBlocks".
    const readDurationBestEffort = async (): Promise<bigint | undefined> => {
      try {
        const fn = (rs as unknown as { getActiveProofingPeriodDurationInBlocks?: () => Promise<unknown> })
          .getActiveProofingPeriodDurationInBlocks;
        if (typeof fn !== 'function') return undefined;
        const v = await fn.call(rs);
        return BigInt(v as never);
      } catch {
        return undefined;
      }
    };
    const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      });
      return Promise.race([
        p.then((v) => { if (timer) clearTimeout(timer); return v; }),
        timeout,
      ]);
    };
    // Single-flight: if a previous tick's probe is still pending,
    // reuse it instead of issuing a fresh `eth_call`. Codex round 8:
    // first invalidate the slot if (a) the resolved RS Contract
    // instance has changed since the probe was started (TTL-refresh
    // path constructs a fresh Contract WITHOUT calling
    // invalidateRandomSamplingPair → the probe was started against
    // the old contract and must not be paired with the new
    // contract's status), or (b) the slot is older than
    // MAX_PROBE_AGE_MS (a truly hung probe must not suppress retries
    // forever).
    const probeAgeMs = this.inflightDurationProbe
      ? Date.now() - this.inflightDurationProbeStartedAt
      : 0;
    if (this.inflightDurationProbe && (
      this.inflightDurationProbeContract !== rs ||
      probeAgeMs > MAX_PROBE_AGE_MS
    )) {
      this.inflightDurationProbe = undefined;
    }
    let probe = this.inflightDurationProbe;
    if (!probe) {
      const fresh = readDurationBestEffort();
      this.inflightDurationProbe = fresh;
      this.inflightDurationProbeContract = rs;
      this.inflightDurationProbeStartedAt = Date.now();
      // `.finally` covers both resolve and reject paths without
      // altering the value the caller observes.
      void fresh.finally(() => {
        if (this.inflightDurationProbe === fresh) {
          this.inflightDurationProbe = undefined;
        }
      });
      probe = fresh;
    }
    const [raw, proofingPeriodDurationInBlocks] = await Promise.all([
      rs.getActiveProofPeriodStatus(),
      withTimeout(probe, DURATION_PROBE_TIMEOUT_MS, undefined),
    ]);
    return {
      activeProofPeriodStartBlock: BigInt(raw.activeProofPeriodStartBlock ?? raw[0]),
      isValid: Boolean(raw.isValid ?? raw[1]),
      proofingPeriodDurationInBlocks,
    };
  }

  async getNodeChallenge(identityId: bigint): Promise<NodeChallenge | null> {
    await this.init();
    const { rss } = await this.getRandomSampling();
    const raw = await this.readContract(
      rss, 'rss.getNodeChallenge', 'getNodeChallenge', identityId,
    );
    return this.toNodeChallenge(raw);
  }

  async getNodeEpochProofPeriodScore(
    identityId: bigint,
    epoch: bigint,
    periodStartBlock: bigint,
  ): Promise<bigint> {
    await this.init();
    const { rss } = await this.getRandomSampling();
    const score: bigint = await this.readContract(
      rss, 'rss.getNodeEpochProofPeriodScore', 'getNodeEpochProofPeriodScore', identityId, epoch, periodStartBlock,
    );
    return BigInt(score);
  }
}
