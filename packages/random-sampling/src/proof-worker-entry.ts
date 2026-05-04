/**
 * Entry script that runs INSIDE the worker_threads worker. The host
 * (`WorkerThreadProofBuilder` in `proof-worker.ts`) sends one task at
 * a time on `parentPort`; this script builds the V10 proof material
 * via `buildV10ProofMaterial` and sends the result back.
 *
 * Errors are flattened to a serializable shape so the host can
 * reconstruct named error classes via `error.name`.
 */
import { parentPort } from 'node:worker_threads';
import {
  buildV10ProofMaterial,
  V10ProofRootMismatchError,
  V10ProofLeafCountMismatchError,
  V10ProofChunkOutOfRangeError,
  type V10MerkleCommitment,
} from '@origintrail-official/dkg-core';

interface BuildRequest {
  /** Monotonic id; echoed in the response so the host can correlate. */
  taskId: number;
  /** Leaves transferred as ArrayBuffer-backed Uint8Array[]. */
  leaves: Uint8Array[];
  chunkId: number;
  expected: V10MerkleCommitment;
}

interface BuildResponse {
  taskId: number;
  ok: true;
  leaf: Uint8Array;
  proof: Uint8Array[];
  merkleRoot: Uint8Array;
  leafCount: number;
}

/**
 * Structured fields carried alongside `errorName` so the host can reconstruct
 * typed errors with their actual values (computed/expected roots, leaf counts,
 * chunk ids) instead of zeroed placeholders. WAL/log diagnostics on the host
 * side are otherwise the only place these values surface, and zeros there
 * make root-cause analysis of mismatch incidents impossible.
 */
type BuildErrorFields =
  | { kind: 'rootMismatch'; computedMerkleRoot: Uint8Array; expectedMerkleRoot: Uint8Array }
  | { kind: 'leafCountMismatch'; computedLeafCount: number; expectedLeafCount: number }
  | { kind: 'chunkOutOfRange'; chunkId: number; leafCount: number };

interface BuildError {
  taskId: number;
  ok: false;
  errorName:
    | 'V10ProofRootMismatchError'
    | 'V10ProofLeafCountMismatchError'
    | 'V10ProofChunkOutOfRangeError'
    | 'Error';
  message: string;
  fields?: BuildErrorFields;
}

if (!parentPort) {
  throw new Error('proof-worker-entry must run inside a worker_threads worker');
}

parentPort.on('message', (msg: BuildRequest) => {
  try {
    const material = buildV10ProofMaterial(msg.leaves, msg.chunkId, msg.expected);
    const response: BuildResponse = {
      taskId: msg.taskId,
      ok: true,
      leaf: material.leaf,
      proof: material.proof,
      merkleRoot: material.merkleRoot,
      leafCount: material.leafCount,
    };
    parentPort!.postMessage(response);
  } catch (err) {
    let errorName: BuildError['errorName'] = 'Error';
    let fields: BuildErrorFields | undefined;
    if (err instanceof V10ProofRootMismatchError) {
      errorName = 'V10ProofRootMismatchError';
      fields = {
        kind: 'rootMismatch',
        computedMerkleRoot: err.computedMerkleRoot,
        expectedMerkleRoot: err.expectedMerkleRoot,
      };
    } else if (err instanceof V10ProofLeafCountMismatchError) {
      errorName = 'V10ProofLeafCountMismatchError';
      fields = {
        kind: 'leafCountMismatch',
        computedLeafCount: err.computedLeafCount,
        expectedLeafCount: err.expectedLeafCount,
      };
    } else if (err instanceof V10ProofChunkOutOfRangeError) {
      errorName = 'V10ProofChunkOutOfRangeError';
      fields = { kind: 'chunkOutOfRange', chunkId: err.chunkId, leafCount: err.leafCount };
    }
    const response: BuildError = {
      taskId: msg.taskId,
      ok: false,
      errorName,
      message: err instanceof Error ? err.message : String(err),
      fields,
    };
    parentPort!.postMessage(response);
  }
});
