// SPDX-License-Identifier: Apache-2.0
import { buildAssertionSealQuads, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, type CanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import { confirmedNamedAssertionSealQuads } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { normalizeLifecycleRepairInput, normalizeLifecycleCoordinates,
  normalizeLifecyclePackedIdentity, normalizeLifecyclePublicationDeployment,
  type ConfirmedLifecycleMaterialization, type ValidatedLifecycleRepairCommand, type ConfirmedNamedKaVmLifecycleInput, type HistoricalUnboundLifecycleRepairInput,
} from './named-ka-vm-lifecycle-evidence.js';
import { createHash } from 'node:crypto';
import type { PreparedLifecycleSnapshot } from './named-ka-vm-lifecycle-snapshots.js';
export type { HistoricalUnboundLifecycleRepairInput } from './named-ka-vm-lifecycle-evidence.js';
type JournalInput = ValidatedLifecycleRepairCommand | HistoricalUnboundLifecycleRepairInput;
export type StoredLifecycleRepairInputV4 = Omit<ConfirmedNamedKaVmLifecycleInput | HistoricalUnboundLifecycleRepairInput, 'packedKaId' | 'tentative' | 'materialization' | 'namedSeal'> & { packedKaId?: string; materializationRef?: string; namedSealQuads?: readonly Quad[] };
interface RepairRetryState {
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  rejected?: boolean;
  /** In-process ownership only; the persisted journal carries its reference. */
  preparedSnapshot?: PreparedLifecycleSnapshot;
}
type DecodedLifecycleEvidence = (
  | { input: ValidatedLifecycleRepairCommand; retention?: never }
  | { input: HistoricalUnboundLifecycleRepairInput; retention: 'historical-unbound' }
);
export type LifecycleRepairEntry = RepairRetryState & DecodedLifecycleEvidence;
/** Persist the stable wire representation; execution-only proof and fingerprint are reconstructed at decode. */
export function lifecycleMaterializationWire(snapshot: ConfirmedLifecycleMaterialization): ConfirmedLifecycleMaterialization {
  return { kaUal: snapshot.kaUal, publicQuads: snapshot.publicQuads, metadataQuads: snapshot.metadataQuads };
}

/** Explicit executable-to-wire boundary shared with historical test fixtures. */
export function lifecycleRepairCoordinatesWire(input: JournalInput): StoredLifecycleRepairInputV4 {
  const { materialization: _materialization, namedSeal, ...coordinates } = input;
  return { ...coordinates, packedKaId: coordinates.packedKaId?.toString(),
    ...(namedSeal ? { namedSealQuads: lifecycleNamedSealWire(namedSeal) } : {}) };
}

const SUBJECT = 'urn:dkg:confirmed-lifecycle-seal';
/** Journal compatibility boundary; ordinary confirmation/admission never renders RDF. */
function decodeLifecycleNamedSealWire(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  if (!Array.isArray(value) || value.some(q => !q || typeof q !== 'object'
    || q.subject !== SUBJECT || q.graph !== '' || typeof q.predicate !== 'string' || typeof q.object !== 'string')) return invalid();
  try {
    const seal = parseAssertionSealQuads(value, SUBJECT);
    if (!seal || seal.contentScopeVersion !== 2 || seal.reservedKaId === undefined || seal.kaUal === undefined
      || seal.assertionVersion === undefined || seal.publicTripleCount === undefined || seal.privateTripleCount === undefined) return invalid();
    const canonicalWire = buildAssertionSealQuads({ ...seal, assertionUri: SUBJECT, metaGraph: '', reservedKaId: seal.reservedKaId, contentScopeVersion: 2,
      kaUal: seal.kaUal, assertionVersion: seal.assertionVersion, publicTripleCount: seal.publicTripleCount,
      privateTripleCount: seal.privateTripleCount, rootEntities: undefined });
    const terms = (quads: readonly Quad[]) => quads.map(q => JSON.stringify([q.predicate, q.object])).sort().join('\n');
    if (terms(value) !== terms(canonicalWire)) return invalid();
    return canonicalGraphScopedAuthorSealFromAssertionSealV1(seal);
  } catch { return invalid(); }
}
function lifecycleNamedSealWire(seal: CanonicalGraphScopedAuthorSealV1): readonly Quad[] {
  return confirmedNamedAssertionSealQuads(seal, SUBJECT, '');
}

function invalid(): never {
  throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed named KA lifecycle repair evidence');
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid();
  return value;
}
export function lifecycleRepairKey(input: ConfirmedNamedKaVmLifecycleInput | HistoricalUnboundLifecycleRepairInput): string {
  // Version-2 disk encoding is frozen independently of the in-process lock namespace.
  // Preserve its original prefix and tuple ordering when changing publisher locks.
  const author = /^0x[0-9a-f]{40}$/i.test(input.agentAddress)
    ? input.agentAddress.toLowerCase() : input.agentAddress;
  const hash = createHash('sha256').update(`assertion-lifecycle:${JSON.stringify([
    input.contextGraphId, input.subGraphName ?? '', author, input.name,
  ])}`);
  // Unbound historical entries keep their exact original key. Distinct deployments
  // share the KA write fence but must never overwrite each other's repair evidence.
  if (input.publicationDeployment) hash.update(JSON.stringify([input.publicationDeployment.chainId, input.publicationDeployment.lifecycleAddress.toLowerCase()]));
  return hash.digest('hex');
}
// Read-only compatibility with the original journal encoding. New writes use
// the version-2 identity encoding; validate the old key before migrating it.
// Version 3 adds verified materialization: older metadata-only readers must refuse it.
function historicalRepairKey(input: JournalInput): string {
  return createHash('sha256').update(JSON.stringify([input.contextGraphId, input.agentAddress.toLowerCase(), input.name, input.subGraphName ?? ''])).digest('hex');
}
/** Production emits only compact v4 records; historical compatibility is read-only. */
export function encodeLifecycleRepairJournal(entries: ReadonlyMap<string, LifecycleRepairEntry>,
  referenceFor: (entry: LifecycleRepairEntry) => string | undefined,
): { version: 4; entries: Array<[string, Omit<LifecycleRepairEntry, 'input' | 'preparedSnapshot'> & { input: StoredLifecycleRepairInputV4 }]> } {
  return { version: 4, entries: [...entries].map(([key, entry]) => {
    // Admission and decode own validation/copying; retry bookkeeping never rehashes payloads.
    const { materialization } = entry.input;
    const input = lifecycleRepairCoordinatesWire(entry.input);
    if (materialization) {
      const ref = referenceFor(entry);
      if (!ref || !/^[a-f0-9]{64}$/.test(ref)) return invalid();
      input.materializationRef = ref;
    }
    const { retention: _retention, preparedSnapshot: _preparedSnapshot, ...retry } = entry;
    return [key, { ...retry, input }];
  }) };
}
function decodeLifecycleRepairInput(value: unknown): DecodedLifecycleEvidence {
  const input = record(value), packed = input['packedKaId'];
  if ('namedSeal' in input) return invalid();
  if (packed !== undefined && !/^[0-9]+$/.test(string(packed))) return invalid();
  const packedKaId = packed === undefined ? undefined : normalizeLifecyclePackedIdentity(BigInt(string(packed)));
  if (packedKaId !== undefined && input['publicationDeployment'] !== undefined) {
    const { namedSealQuads, ...coordinates } = input;
    return { input: normalizeLifecycleRepairInput({ ...coordinates, packedKaId,
      ...(namedSealQuads === undefined ? {} : { namedSeal: decodeLifecycleNamedSealWire(namedSealQuads) }) }) };
  }
  // Historical incomplete commands remain retained and can never reach execution.
  if (input['materialization'] !== undefined) return invalid();
  return { retention: 'historical-unbound', input: Object.freeze({
    ...normalizeLifecycleCoordinates(input),
    ...(packedKaId === undefined ? {} : { packedKaId }),
    ...(input['publicationDeployment'] === undefined ? {} : {
      publicationDeployment: normalizeLifecyclePublicationDeployment(input['publicationDeployment']),
    }),
  }) };
}
export interface LifecycleRepairWireEntry {
  readonly entry: LifecycleRepairEntry;
  readonly materializationRef?: string;
}
/** Validate every wire version, tuple, identity, retry field and reference before snapshot I/O. */
export function decodeLifecycleRepairJournalWire(value: unknown): Map<string, LifecycleRepairWireEntry> {
  const journal = record(value);
  if ((journal['version'] !== 1 && journal['version'] !== 2 && journal['version'] !== 3 && journal['version'] !== 4) || !Array.isArray(journal['entries'])) return invalid();
  const entries = new Map<string, LifecycleRepairWireEntry>();
  const storedKeys = new Set<string>();
  for (const tuple of journal['entries']) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string') return invalid();
    const entry = record(tuple[1]), stored = record(entry['input']);
    const ref = stored['materializationRef'];
    if ((journal['version'] !== 4 && ref !== undefined) || (journal['version'] === 4 && stored['materialization'] !== undefined)) return invalid();
    if (ref !== undefined && (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref))) return invalid();
    const evidence = decodeLifecycleRepairInput(stored);
    if (ref !== undefined && evidence.retention !== undefined) return invalid();
    const input = evidence.input;
    const key = lifecycleRepairKey(input), attempts = entry['attempts'], nextAttemptAt = entry['nextAttemptAt'];
    const storedKey = journal['version'] === 1 ? historicalRepairKey(input) : key;
    if (tuple[0] !== storedKey || storedKeys.has(storedKey) || entries.has(key) || typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0
      || typeof nextAttemptAt !== 'number' || !Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0
      || (entry['lastError'] !== undefined && typeof entry['lastError'] !== 'string')
      || (entry['rejected'] !== undefined && typeof entry['rejected'] !== 'boolean')) return invalid();
    storedKeys.add(storedKey);
    entries.set(key, { entry: { ...evidence, attempts, nextAttemptAt,
      ...(entry['lastError'] === undefined ? {} : { lastError: entry['lastError'] }),
      ...(entry['rejected'] === undefined ? {} : { rejected: entry['rejected'] }),
    }, ...(typeof ref === 'string' ? { materializationRef: ref } : {}) });
  }
  return entries;
}

/** Bind a verified snapshot to typed coordinates, reconstructing immutable executable evidence. */
export function hydrateLifecycleRepairWireEntry(wire: LifecycleRepairWireEntry, snapshot?: unknown): LifecycleRepairEntry {
  if (wire.materializationRef === undefined) return wire.entry;
  if (snapshot === undefined || wire.entry.retention !== undefined) return invalid();
  return { ...wire.entry, input: normalizeLifecycleRepairInput({ ...wire.entry.input, materialization: snapshot }) };
}

export function decodeLifecycleRepairJournal(value: unknown, snapshots?: ReadonlyMap<string, unknown>): Map<string, LifecycleRepairEntry> {
  return new Map([...decodeLifecycleRepairJournalWire(value)].map(([key, wire]) => [
    key, hydrateLifecycleRepairWireEntry(wire, wire.materializationRef === undefined ? undefined : snapshots?.get(wire.materializationRef)),
  ]));
}
