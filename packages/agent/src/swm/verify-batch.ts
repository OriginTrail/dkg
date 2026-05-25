/**
 * OT-RFC-38 LU-8 — Member post-decrypt batch verification.
 *
 * SPEC_CG_HOSTING_MEMBERSHIP §5.3.1 ("Member verification"):
 *
 *   "Member ... reconstructs the per-KA leaves using the existing V10
 *   leaf format. For each batch they reconstruct, re-derives the merkle
 *   root and compares to the on-chain anchor."
 *
 * This module is the canonical implementation of that recompute step.
 * It is intentionally *purely a recomputer* — it does NOT fetch chain
 * state, does NOT touch the local store, and does NOT decrypt. Callers
 * pass in:
 *
 *   - the already-decrypted plaintext `quads` of the batch (the
 *     publishable payload, identical to what was leaf-hashed at publish
 *     time)
 *   - any per-KA `privateRoots` that were folded into the publisher's
 *     `computeFlatKCRootV10` call (matching the publisher's seal logic)
 *   - the `expectedRoot` retrieved from chain (V10 batch entry) — 32
 *     bytes, the canonical form `KnowledgeAssetsV10` stores.
 *
 * The return is a small structured result; the caller decides what to
 * do with rejection (the agent emits a `BatchRejected` SWM gossip
 * record, see {@link buildBatchRejectionRecord}).
 *
 * Why a separate module rather than reusing `publisher/src/merkle.ts`:
 * member-side verification has different security posture from publish
 * — wrong leaf shape on the publisher's side means *their own* publish
 * fails locally; wrong leaf shape on the verifier's side means a
 * malicious publisher slips a bad batch through. Pinning verification
 * to a thin, audited surface that does ONLY the recompute+compare keeps
 * the security boundary small.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import { keccak256 } from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
} from '@origintrail-official/dkg-publisher';

export interface VerifyBatchInput {
  /**
   * Decrypted plaintext quads of the batch. Order does not matter:
   * V10 merkle is sort+dedupe, so any caller-supplied permutation
   * produces the same root.
   */
  quads: Quad[];

  /**
   * Optional per-KA private roots that the publisher folded into the
   * flat KC root via {@link computeFlatKCRootV10}. For curated
   * single-KA batches (the LU-5 path) this is typically empty — the
   * payload itself is private and the whole batch hashes as a single
   * tree.
   */
  privateRoots?: Uint8Array[];

  /**
   * The on-chain anchor (V10 batch `merkleRoot`). 32 bytes (`bytes32`).
   */
  expectedRoot: Uint8Array;
}

export interface VerifyBatchResult {
  ok: boolean;
  /** Expected root (echo of the input, hex-encoded for diagnostics). */
  expectedRoot: string;
  /** Recomputed root from the supplied plaintext, hex-encoded. */
  actualRoot: string;
  /** Leaf count after V10 sort+dedupe. */
  leafCount: number;
  /**
   * When `ok === false`, the most actionable next step the caller can
   * surface in logs / UI. The verify-batch contract is "tell me what
   * happened", not "fix it" — the caller chooses whether to retry
   * fetch from a different host (LU-7 catchup), emit a `BatchRejected`
   * gossip (this module's `buildBatchRejectionRecord` helper), or both.
   */
  reason?: 'root-mismatch' | 'empty-quads' | 'invalid-expected-root';
}

const ZERO_ROOT = new Uint8Array(32);

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function verifyBatch(input: VerifyBatchInput): VerifyBatchResult {
  if (input.expectedRoot.length !== 32) {
    return {
      ok: false,
      expectedRoot: bytesToHex(input.expectedRoot),
      actualRoot: bytesToHex(ZERO_ROOT),
      leafCount: 0,
      reason: 'invalid-expected-root',
    };
  }

  if (input.quads.length === 0 && (input.privateRoots?.length ?? 0) === 0) {
    return {
      ok: false,
      expectedRoot: bytesToHex(input.expectedRoot),
      actualRoot: bytesToHex(ZERO_ROOT),
      leafCount: 0,
      reason: 'empty-quads',
    };
  }

  const privateRoots = input.privateRoots ?? [];
  const actualRoot = computeFlatKCRootV10(input.quads, privateRoots);
  const leafCount = computeFlatKCMerkleLeafCountV10(input.quads, privateRoots);

  let match = true;
  for (let i = 0; i < 32; i++) {
    if (actualRoot[i] !== input.expectedRoot[i]) {
      match = false;
      break;
    }
  }

  return {
    ok: match,
    expectedRoot: bytesToHex(input.expectedRoot),
    actualRoot: bytesToHex(actualRoot),
    leafCount,
    ...(match ? {} : { reason: 'root-mismatch' as const }),
  };
}

/**
 * SPEC §5.3.1: "On mismatch: reject batch, alert via SWM, retry from a
 * different hosting core."
 *
 * `buildBatchRejectionRecord` shapes the alert as a structured record
 * suitable for SWM gossip. The shape is intentionally minimal — every
 * field has a clear consumer downstream:
 *
 *   - `contextGraphId` — scopes who cares about the rejection (CG
 *     subscribers).
 *   - `batchId` / `merkleRoot` — identifies the batch unambiguously so
 *     receivers can correlate with their own pending verifies.
 *   - `actualRoot` — what the rejecter computed. Lets other members
 *     independently sanity-check whether they would have rejected too.
 *   - `rejectedBy` — agent address (and optional peerId) for
 *     attribution. Important for any future "did this rejecter ALSO
 *     get punished for spurious rejections" workflow (Phase B).
 *   - `reportedAt` — wall-clock for ordering / rate-limiting on the
 *     consumer side.
 *   - `digest` — keccak256 of all the above so the SWM consumer can
 *     hash-dedupe identical rejection reports.
 *
 * Returns a plain JS object — callers serialise into SWM (typically as
 * RDF triples under `did:dkg:batch-rejection:<digest>` in the
 * `_shared_memory` named graph). Doing the serialisation here would
 * pull in DKG RDF helpers and tie this module to a specific store
 * shape; a tiny pure object is the right level of indirection.
 */
export interface BatchRejectionRecord {
  contextGraphId: string;
  batchId?: string;
  expectedRoot: string;
  actualRoot: string;
  reason: VerifyBatchResult['reason'];
  rejectedBy: {
    agentAddress: string;
    peerId?: string;
  };
  reportedAt: string;
  digest: string;
}

export function buildBatchRejectionRecord(input: {
  contextGraphId: string;
  batchId?: string;
  verifyResult: VerifyBatchResult;
  rejectedBy: { agentAddress: string; peerId?: string };
  now?: () => Date;
}): BatchRejectionRecord {
  if (input.verifyResult.ok) {
    throw new Error('buildBatchRejectionRecord called on an ok verify result; nothing to reject');
  }

  const reportedAt = (input.now ?? (() => new Date()))().toISOString();
  // Codex PR #609: `reportedAt` MUST NOT be in the digest. The doc
  // contract is "hash-dedupe identical rejection reports": when a
  // member retries the same rejection (e.g. transient gossip drop,
  // restart), the digest is the dedupe key on the consuming side. If
  // we include `reportedAt` in the hash, every retry produces a fresh
  // digest → fresh subject URI → the SWM substrate stores every retry
  // as a distinct record, defeating dedupe. The digest covers the
  // identity of the rejection (which CG, which batch, what verify
  // result, who reported it); `reportedAt` is metadata that travels
  // alongside the record but does not gate identity.
  const digestInput = new TextEncoder().encode(
    [
      input.contextGraphId,
      input.batchId ?? '',
      input.verifyResult.expectedRoot,
      input.verifyResult.actualRoot,
      input.verifyResult.reason ?? 'unknown',
      input.rejectedBy.agentAddress,
    ].join('|'),
  );
  const digest = bytesToHex(keccak256(digestInput));

  return {
    contextGraphId: input.contextGraphId,
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    expectedRoot: input.verifyResult.expectedRoot,
    actualRoot: input.verifyResult.actualRoot,
    reason: input.verifyResult.reason,
    rejectedBy: { ...input.rejectedBy },
    reportedAt,
    digest,
  };
}
