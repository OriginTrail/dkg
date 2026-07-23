import { createHash } from 'node:crypto';
import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
  type VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryState,
} from './finalization-recovery-store.js';

const LIVE_STATES = new Set<FinalizationRecoveryState>([
  'RECEIVED',
  'VERIFIED',
  'REORGED',
]);
const TERMINAL_STATES = new Set<FinalizationRecoveryState>([
  'SETTLED',
  'SUPERSEDED',
  'REJECTED',
  'UNSUPPORTED',
]);

function asSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Finalization inbox row has invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function finalizationEnvelopeSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function finalizationRecoveryRowToEntry(
  row: Record<string, unknown>,
): FinalizationRecoveryEntry {
  const state = String(row.state) as FinalizationRecoveryState;
  if (!LIVE_STATES.has(state) && !TERMINAL_STATES.has(state)) {
    throw new Error('Finalization inbox row has invalid state');
  }
  const raw = row.raw_envelope;
  if (!(raw instanceof Uint8Array)) {
    throw new Error('Finalization inbox row has invalid envelope');
  }
  const envelopeSha256 = String(row.envelope_sha256);
  if (
    !/^[0-9a-f]{64}$/.test(envelopeSha256)
    || finalizationEnvelopeSha256(raw) !== envelopeSha256
  ) {
    throw new Error('Finalization inbox row has invalid envelope integrity');
  }
  const verifiedEvidence = row.verified_evidence_json === null
    ? undefined
    : VerifiedGraphScopedFinalizationEvidenceCodec.parse(
      JSON.parse(String(row.verified_evidence_json)),
    );
  const evidenceColumns = [
    row.block_number,
    row.block_hash,
    row.tx_index,
    row.publisher_address,
    row.author_address,
  ];
  if (!verifiedEvidence && evidenceColumns.some((value) => value !== null)) {
    throw new Error('Finalization inbox row has provenance without verified evidence');
  }
  if (state === 'REORGED' && verifiedEvidence) {
    throw new Error('Finalization inbox reorged row retains stale verified evidence');
  }
  if (verifiedEvidence) {
    const storedAuthor = optionalString(row.author_address)?.toLowerCase();
    if (
      asSafeInteger(row.block_number, 'block_number') !== verifiedEvidence.blockNumber
      || String(row.block_hash).toLowerCase() !== verifiedEvidence.blockHash.toLowerCase()
      || asSafeInteger(row.tx_index, 'tx_index') !== verifiedEvidence.txIndex
      || String(row.publisher_address).toLowerCase()
        !== verifiedEvidence.publisherAddress.toLowerCase()
      || storedAuthor !== verifiedEvidence.authorAddress?.toLowerCase()
    ) {
      throw new Error('Finalization inbox row has inconsistent verified provenance');
    }
  }
  return {
    key: String(row.key),
    state,
    chainId: String(row.chain_id),
    contextGraphId: String(row.context_graph_id),
    ...(optionalString(row.source_peer_id)
      ? { sourcePeerId: String(row.source_peer_id) }
      : {}),
    ...(optionalString(row.trusted_publisher_peer_id)
      ? { trustedPublisherPeerId: String(row.trusted_publisher_peer_id) }
      : {}),
    ual: String(row.ual),
    txHash: String(row.tx_hash),
    assertionVersion: String(row.assertion_version),
    merkleRoot: String(row.merkle_root),
    kaId: String(row.ka_id),
    batchId: String(row.batch_id),
    ...(optionalString(row.target_context_graph_id)
      ? { targetContextGraphId: String(row.target_context_graph_id) }
      : {}),
    envelopeSha256,
    rawMessage: new Uint8Array(raw),
    ...(verifiedEvidence ? { verifiedEvidence } : {}),
    generation: asSafeInteger(row.generation, 'generation'),
    attemptCount: asSafeInteger(row.attempt_count, 'attempt_count'),
    ...(row.next_attempt_at === null
      ? {}
      : { nextAttemptAt: asSafeInteger(row.next_attempt_at, 'next_attempt_at') }),
    ...(optionalString(row.last_error) ? { lastError: String(row.last_error) } : {}),
    createdAt: asSafeInteger(row.created_at, 'created_at'),
    updatedAt: asSafeInteger(row.updated_at, 'updated_at'),
  };
}

export function sameFinalizationRecoveryEvidence(
  left: VerifiedGraphScopedFinalizationEvidence,
  right: VerifiedGraphScopedFinalizationEvidence,
): boolean {
  return VerifiedGraphScopedFinalizationEvidenceCodec.same(left, right);
}
