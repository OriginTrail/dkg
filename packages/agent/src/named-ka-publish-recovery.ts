// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  buildKnowledgeAssetUal,
  type ChainAdapter,
} from '@origintrail-official/dkg-chain';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type {
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  KnowledgeAssetVmPublishRequest,
} from '@origintrail-official/dkg-publisher';
import { unpackKnowledgeAssetId } from './ka-identity.js';

export interface RecoveredNamedKaPublish {
  readonly reservedKaId: bigint;
  /**
   * The single canonical graph-local identity of this named KA (author address + low-96 KA
   * number), derived from the request — never the raw resolver wire form. This is what a normal
   * publish records, and it is used both to drive local materialization and to stamp the asset's
   * `publishedUal`. The immutable identity is `reservedKaId`; this is its graph-local rendering.
   */
  readonly localUal: string;
  readonly txHash: string;
  readonly receiptBlockNumber: number;
  readonly transaction: {
    readonly merkleRoot: string;
    readonly authorAddress: string;
    readonly publisherAddress: string;
    readonly blockHash: string;
    readonly txIndex: number;
  };
  readonly materialization: {
    readonly merkleRoot: string;
    readonly authorAddress: string;
    readonly publisherAddress: string;
    readonly versionBlock: number;
    readonly superseded: boolean;
  };
}

function recoveryInconsistent(name: string, message: string): Error {
  return Object.assign(new Error(`Named KA recovery rejected for "${name}": ${message}`), {
    code: 'KA_VM_RECOVERY_INCONSISTENT',
  });
}

/**
 * Case-insensitive comparison, named for exactly what it does. It is the right test for both
 * kinds of evidence compared here: hex evidence (tx hashes, merkle roots) whose casing is not
 * significant, and the two published-UAL representations, whose only case-variable segment is
 * the embedded hex address — every other segment is already canonical by construction
 * (`buildKnowledgeAssetUal` lowercases, `createGraphKnowledgeAssetScope` canonicalizes).
 */
function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Validate immutable transaction evidence, then separately resolve the chain's
 * current version for local materialization. A later update must never make the
 * original confirmed publish unrecoverable or regress the VM pointer.
 */
/**
 * r27 (🔴 3821200852) — the pass deadline, checked between reads. Throwing is the right shape
 * here: the caller already treats a throw as "repair blocked, job stays tx-bearing", which is
 * exactly the disposition a deadline earns. It is deliberately NOT `inconsistent` — nothing about
 * the chain was found to be wrong, we simply ran out of budget.
 */
class RecoveryDeadlineReachedError extends Error {
  constructor() {
    super('named-KA recovery deadline reached before the chain reads completed');
    this.name = 'RecoveryDeadlineReachedError';
  }
}

function throwIfRecoveryDeadlineReached(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RecoveryDeadlineReachedError();
}

export async function normalizeRecoveredNamedKaPublish(input: {
  readonly request: KnowledgeAssetVmPublishRequest;
  /**
   * The queued transaction's identity — the tx hash the resolved receipt must be bound to, and the
   * merkle root to cross-check against the seal when the record carries one.
   *
   * GH#2270 PR-3 r3 — named facts rather than `job.broadcast`. A failed job held on the recovery
   * carrier alone has no broadcast metadata at all, so a caller could only satisfy the old shape
   * by rebuilding one; the two things actually read are now simply asked for.
   */
  readonly queued: { readonly txHash: string; readonly merkleRoot?: string };
  /**
   * GH#2270 PR #2300 r27 (🔴 3821200852) — the recovery pass DEADLINE. Everything this function
   * does before the caller mutates anything is read-only chain work, so it belongs inside the
   * dispatcher's bounded phase. Without it a stalled snapshot read outlived the budget and held
   * the global claim lock, blocking claims, admission and clears for that graph.
   */
  readonly signal?: AbortSignal;
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
  readonly chain: ChainAdapter;
}): Promise<RecoveredNamedKaPublish> {
  const { request, queued, recovery, chain, signal } = input;
  const inconsistent = (message: string): Error => recoveryInconsistent(request.name, message);

  if (!equalsIgnoreCase(queued.txHash, recovery.inclusion.txHash)) {
    throw inconsistent(
      `resolved inclusion tx ${recovery.inclusion.txHash} does not match queued tx ${queued.txHash}`,
    );
  }
  if (!recovery.finalization.txHash || !equalsIgnoreCase(queued.txHash, recovery.finalization.txHash)) {
    throw inconsistent('resolved finalization is not bound to the queued transaction hash');
  }
  if (queued.merkleRoot && !equalsIgnoreCase(queued.merkleRoot, request.sealMerkleRoot)) {
    throw inconsistent(
      `queued broadcast merkle root ${queued.merkleRoot} does not match seal ${request.sealMerkleRoot}`,
    );
  }

  let immutableIdentity: {
    reservedKaId: bigint;
    sealedAuthor: string;
    localUal: string;
  };
  try {
    const sealedAuthor = ethers.getAddress(request.seal.authorAddress);
    let reservedKaId: bigint;
    if (request.seal.reservedKaId !== undefined) {
      reservedKaId = BigInt(request.seal.reservedKaId);
    } else if (request.kaNumber !== undefined) {
      reservedKaId = (BigInt(sealedAuthor) << 96n) | BigInt(request.kaNumber);
    } else {
      throw new Error('the immutable request has no reserved KA id');
    }
    if (reservedKaId < 0n) throw new Error('reserved KA id must be non-negative');

    const unpacked = unpackKnowledgeAssetId(reservedKaId);
    if (unpacked.agentAddress.toLowerCase() !== sealedAuthor.toLowerCase()) {
      throw new Error('reserved KA id author bits do not match the signed author address');
    }
    if (request.kaUal === undefined || request.assertionVersion === undefined) {
      throw new Error('the immutable request has no graph-scoped KA identity');
    }
    const localScope = createGraphKnowledgeAssetScope(
      request.kaUal,
      request.assertionVersion,
    );
    if (localScope.chainId !== chain.chainId) {
      throw new Error('queued graph UAL is not bound to the recovery chain');
    }
    if (
      localScope.agentAddress.toLowerCase() !== unpacked.agentAddress.toLowerCase()
      || BigInt(localScope.kaNumber) !== unpacked.kaNumber
    ) {
      throw new Error(
        `queued graph UAL ${localScope.ual} does not identify reserved KA id ${reservedKaId.toString()}`,
      );
    }
    immutableIdentity = { reservedKaId, sealedAuthor, localUal: localScope.ual };
  } catch (error) {
    throw inconsistent(`invalid reserved KA identity: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { reservedKaId, sealedAuthor, localUal } = immutableIdentity;

  const { batchId, startKAId, endKAId, ual, publisherAddress } = recovery.finalization;
  if (!batchId || !startKAId || !endKAId) {
    throw inconsistent('chain recovery did not return a singleton V10 KA range');
  }
  for (const [field, value] of [
    ['batchId', batchId],
    ['startKAId', startKAId],
    ['endKAId', endKAId],
  ] as const) {
    let parsed: bigint;
    try {
      parsed = BigInt(value);
    } catch {
      throw inconsistent(`${field} ${value} is not a valid KA id`);
    }
    if (parsed !== reservedKaId) {
      throw inconsistent(`${field} ${value} does not match reserved KA id ${reservedKaId.toString()}`);
    }
  }
  if (!ual) throw inconsistent('chain recovery did not return the published UAL');
  // The normalized identity is always the canonical graph-local `localUal`, never the raw
  // resolver wire form. Cross-check the returned `ual` against the SAME reserved packed KA id
  // in either proven-equivalent representation — both already bound to chain truth by the
  // batchId/startKAId/endKAId === reservedKaId (above) and the author-bit / localScope checks,
  // all independent of `ual`. Match the graph-local form first (the shape the CLI resolver
  // surfaces for named KAs); only when it does not match do we resolve and compare the
  // canonical chain-receipt form (DKGKnowledgeAssets contract + packed id) the generic mapper
  // produces — so the common named-KA path never needs the contract address. Every other UAL
  // fails closed; `ual` is validated here and never exported.
  if (!equalsIgnoreCase(ual, localUal)) {
    let expectedReceiptUal: string;
    try {
      if (!chain.getDKGKnowledgeAssetsAddress) {
        throw new Error('the configured chain adapter cannot resolve the DKGKnowledgeAssets address');
      }
      const knowledgeAssetsContract = await chain.getDKGKnowledgeAssetsAddress();
      expectedReceiptUal = buildKnowledgeAssetUal(
        chain.chainId,
        ethers.getAddress(knowledgeAssetsContract),
        reservedKaId,
      );
    } catch (error) {
      throw inconsistent(
        `could not resolve the canonical receipt UAL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!equalsIgnoreCase(ual, expectedReceiptUal)) {
      throw inconsistent(
        `published receipt UAL ${ual} does not match the graph-local UAL ${localUal} or the canonical receipt UAL ${expectedReceiptUal}`,
      );
    }
  }
  if (!publisherAddress || !ethers.isAddress(publisherAddress)) {
    throw inconsistent('chain recovery did not return a valid publisher address');
  }
  const transactionPublisher = ethers.getAddress(publisherAddress);

  const proof = recovery.publishProof;
  const blockHash = recovery.inclusion.blockHash;
  if (!blockHash || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw inconsistent('chain recovery did not return a valid canonical block hash');
  }
  if (!equalsIgnoreCase(proof.merkleRoot, request.sealMerkleRoot)) {
    throw inconsistent(
      `transaction merkle root ${proof.merkleRoot} does not match queued seal ${request.sealMerkleRoot}`,
    );
  }
  if (!ethers.isAddress(proof.authorAddress)) {
    throw inconsistent('chain recovery did not return the transaction author');
  }
  if (!Number.isSafeInteger(proof.txIndex) || proof.txIndex < 0) {
    throw inconsistent('chain recovery did not return a valid transaction index');
  }
  const transactionAuthor = ethers.getAddress(proof.authorAddress);
  if (transactionAuthor === ethers.ZeroAddress || transactionAuthor.toLowerCase() !== sealedAuthor.toLowerCase()) {
    throw inconsistent(
      `transaction author ${transactionAuthor} does not match sealed author ${sealedAuthor}`,
    );
  }

  // r12 (3813506089) — the coherent view is consulted FIRST, and when it exists it is the only
  // chain view this decision uses. The standalone latest-root read is the legacy path for proofs
  // that carry no position, so a node whose adapter can produce the view must not be blocked by
  // that read failing (or by an adapter that lacks it).
  throwIfRecoveryDeadlineReached(signal);
  const versionView = await chain
    .readKnowledgeAssetVersionSnapshot?.(reservedKaId, { signal })
    .catch(() => null);
  throwIfRecoveryDeadlineReached(signal);
  // r21 (🔴 3816769865) — the position is derived HERE, above the no-view guard, because the
  // guard has to key off the DERIVED position and not merely a persisted `merkleRootCount`. A
  // create carries no count but has position 1 by construction, so gating on the field alone let a
  // marked create fall through to the root-only fallback whenever the coherent view was briefly
  // unavailable — and in an A -> B -> A history the create's root equals the latest, so it would
  // be recorded as current and stamp its old author and block over newer state. That is the exact
  // ambiguity the position comparison exists to remove, reachable through the back door.
  const recoveredPosition = proof.merkleRootCount !== undefined
    ? BigInt(proof.merkleRootCount)
    : (proof.operationKind === 'create' ? 1n : undefined);
  if (!versionView && recoveredPosition !== undefined) {
    throw inconsistent(
      'the current KA version could not be established from a single coherent chain view; '
      + 'recovery is deferred rather than deciding supersession from a weaker signal',
    );
  }
  if (!versionView && !chain.getLatestMerkleRoot) {
    throw inconsistent('the configured chain adapter cannot resolve the current KA merkle root');
  }
  const latestMerkleRoot = versionView
    ? versionView.latestRoot
    : ethers.hexlify(await chain.getLatestMerkleRoot!(reservedKaId, { signal }));
  // GH#2270 PR #2300 r5 (3812275749) — supersession is a question about POSITION in the update
  // history, and root bytes cannot answer it: an asset updated A -> B -> A makes the FIRST
  // update's root equal the latest one, so root equality would call that old transaction current
  // and stamp its provenance and version block over newer state. When the recovery evidence
  // carries the verified position, compare positions; root equality remains the fallback for
  // evidence that predates the field or an adapter that cannot count roots, which is no worse
  // than the behaviour it replaces.
  // Each signal may only ADD evidence of supersession; neither may erase the other's (r6 review,
  // 3812436109). The two reads are separate round trips and can observe different chain states, so
  // a lagging count that merely fails to prove supersession must not overturn a root read that
  // already did — that would materialize an old transaction as current and stamp its provenance
  // over newer state, which is the exact failure the position check was added to prevent.
  // GH#2270 PR #2300 — ONE view decides everything about the CURRENT version, or nothing does.
  //
  // Root, count, author, publisher and height must come from a single pinned observation: deciding
  // from one read and materializing from another writes a lifecycle version that never existed on
  // chain. And when that observation is unavailable there is no weaker answer to fall back to —
  // root equality cannot tell an old repeated root from the current one (an A -> B -> A history),
  // so falling back to it would stamp stale provenance exactly when the real proof is missing
  // (r12, 3813505553). A job whose proof carries a position therefore DEFERS instead: it stays
  // held, tx-bearing, and the next recovery tick asks again.
  // r16 (3814609231) — a create's position is 1 BY CONSTRUCTION: the mint writes the first root.
  // Last round I reasoned that minting once made a create permanently current, which confused
  // identity permanence with root currency — a later update can restore the create's root bytes,
  // and root equality would then record the create as current over the newer version. So creates
  // get the same position comparison, from a position that needs no extra chain read.
  // Only evidence that SAYS it is an update is held to the position rule. Evidence carrying no
  // operation kind at all is the pre-marker legacy shape (r15, 3814317919): it keeps the
  // latest-root comparison it always had, because there is nothing better available for it and
  // refusing it outright would strand records this build did not write.
  if (proof.operationKind === 'update' && recoveredPosition === undefined) {
    throw inconsistent(
      'a recovered update carries no history position, so its currency cannot be established from '
      + 'root bytes alone; recovery is deferred',
    );
  }
  // r14 (3814016877) — the staleness test comes FIRST and does not depend on how the roots
  // compare. A view behind this transaction's own position has not seen it, and a lagging view
  // naturally shows a PREDECESSOR root — so gating the check on "the roots matched" let exactly
  // that case through and materialized the predecessor as the current version. The transaction is
  // on chain at this position; any view reporting fewer roots is stale, whatever root it names.
  if (versionView && recoveredPosition !== undefined && versionView.rootCount < recoveredPosition) {
    throw inconsistent(
      'the current KA version view is behind the recovered transaction position; '
      + 'recovery is deferred rather than treating a stale view as current',
    );
  }
  // r15 (3814317546) — an UPDATE with no recorded position cannot be settled by root bytes at all:
  // that is precisely the A -> B -> A case, where the first update's root equals the latest and
  // root equality would record it as current over the third. The built-in adapter supplies the
  // position, so this is the fail-closed answer for evidence that does not — a create is different
  // and keeps the root comparison, because a create's identity is minted once and never restored.
  let superseded: boolean;
  if (versionView && recoveredPosition !== undefined) {
    // r28 (🔴 3821720818) — with BOTH a coherent view and a position, the POSITION decides,
    // and the root is a consistency check rather than a second opinion. The three cases are
    // exhaustive and each has one honest answer:
    //   count <  position  the view has not seen this transaction yet (handled above: defer).
    //   count == position  the view describes THIS version, so its root must be ours. A different
    //                      root at the same position is not a later version — it is a CONTRADICTION
    //                      (a forked or inconsistent endpoint), and calling it supersession
    //                      finalizes the job receipt-only while the lifecycle is never repaired.
    //   count >  position  a later write exists: genuinely superseded.
    // Deriving supersession from root bytes first, as this did, made the middle case look like the
    // last one purely because the roots differed.
    if (versionView.rootCount === recoveredPosition
      && !equalsIgnoreCase(versionView.latestRoot, proof.merkleRoot)) {
      throw inconsistent(
        'the current KA version view reports this transaction position with a DIFFERENT root; '
        + 'the evidence is contradictory and recovery is deferred rather than assuming supersession',
      );
    }
    superseded = versionView.rootCount > recoveredPosition;
  } else {
    // No position to compare (legacy evidence, or no coherent view): the root is all there is.
    superseded = versionView
      ? !equalsIgnoreCase(versionView.latestRoot, proof.merkleRoot)
      : !equalsIgnoreCase(latestMerkleRoot, proof.merkleRoot);
  }

  let materializationAuthor = transactionAuthor;
  let materializationPublisher = transactionPublisher;
  let versionBlock = recovery.inclusion.blockNumber;

  if (superseded) {
    // r11 — the pinned view already carries the attribution and the height, so the legacy
    // per-fact getters are required only on the fallback path that still needs them.
    if (!versionView
      && (!chain.getLatestMerkleRootAuthor || !chain.getLatestMerkleRootPublisher || !chain.getBlockNumber)) {
      throw inconsistent('the configured chain adapter cannot safely materialize a superseding KA version');
    }
    if (versionView) {
      materializationAuthor = ethers.getAddress(versionView.latestAuthor);
      materializationPublisher = ethers.getAddress(versionView.latestPublisher);
      versionBlock = versionView.blockNumber;
    } else if (chain.getLatestMerkleRootAuthor && chain.getLatestMerkleRootPublisher && chain.getBlockNumber) {
      throwIfRecoveryDeadlineReached(signal);
      materializationAuthor = ethers.getAddress(await chain.getLatestMerkleRootAuthor(reservedKaId, { signal }));
      materializationPublisher = ethers.getAddress(await chain.getLatestMerkleRootPublisher(reservedKaId, { signal }));
      versionBlock = await chain.getBlockNumber();
    } else {
      // Unreachable: the guard above already rejected this combination. Narrowing it here keeps
      // the fallback's capability requirement expressed in one place at the type level too.
      throw inconsistent('the configured chain adapter cannot safely materialize a superseding KA version');
    }
    if (materializationAuthor === ethers.ZeroAddress || materializationPublisher === ethers.ZeroAddress) {
      throw inconsistent('the superseding KA version has an invalid author or publisher');
    }
  }

  return {
    reservedKaId,
    localUal,
    txHash: recovery.inclusion.txHash,
    receiptBlockNumber: recovery.inclusion.blockNumber,
    transaction: {
      merkleRoot: ethers.hexlify(proof.merkleRoot),
      authorAddress: transactionAuthor,
      publisherAddress: transactionPublisher,
      blockHash,
      txIndex: proof.txIndex,
    },
    materialization: {
      merkleRoot: versionView?.latestRoot ?? latestMerkleRoot,
      authorAddress: materializationAuthor,
      publisherAddress: materializationPublisher,
      versionBlock,
      superseded,
    },
  };
}
