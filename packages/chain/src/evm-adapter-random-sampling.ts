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
import { MAX_PROBE_AGE_MS, DURATION_PROBE_TIMEOUT_MS } from './evm-adapter-constants.js';

export class RandomSamplingMethods extends EVMChainAdapterBase {
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
    opts?: { gasLimitBufferBps?: number },
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
        // Drop the selection-time revalidation stamp too: the wallet just
        // PROVED it no longer resolves to this identity, so a lingering stamp
        // must not vouch for it if it is ever re-admitted within the TTL.
        this.rsSignerRevalidatedAt.delete(signer.address.toLowerCase());
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
          // createChallenge's gas depends on per-block randomness (weighted
          // CG draw + `blockhash` entropy in `_deriveChallengeSeed`). The
          // estimate is taken against a different block than the one the tx
          // mines in, so without headroom the tx intermittently OOGs and
          // reverts with empty `0x` data. +50% covers the estimate-vs-exec
          // spread with margin for production CG/KC counts.
          { gasLimitBufferBps: 5_000 },
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
