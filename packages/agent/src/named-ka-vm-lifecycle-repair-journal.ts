// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { normalizeLifecycleMaterialization } from './named-ka-vm-lifecycle-materialization.js';
import { createHash } from 'node:crypto';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';
export type HistoricalUnboundLifecycleRepairInput = Omit<ConfirmedNamedKaVmLifecycleInput, 'publicationDeployment' | 'packedKaId'> & {
  readonly publicationDeployment?: ConfirmedNamedKaVmLifecycleInput['publicationDeployment'];
  readonly packedKaId?: bigint;
};
type JournalInput = ConfirmedKaInput | HistoricalUnboundLifecycleRepairInput;
type ConfirmedKaInput = ConfirmedNamedKaVmLifecycleInput;
export type StoredLifecycleRepairInput = Omit<JournalInput, 'packedKaId' | 'tentative'> & { packedKaId?: string };
interface RepairRetryState {
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  rejected?: boolean;
}
export type LifecycleRepairEntry = RepairRetryState & (
  | { input: ConfirmedKaInput; retention?: never }
  | { input: HistoricalUnboundLifecycleRepairInput; retention: 'historical-unbound' }
);
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
function root(value: unknown): string {
  const text = string(value);
  if (!/^(0x)?[0-9a-f]{64}$/i.test(text)) return invalid();
  return text.toLowerCase().replace(/^0x/, '');
}
export function normalizeLifecycleRepairInput(value: unknown): ConfirmedNamedKaVmLifecycleInput {
  const input = normalizeJournalInput(value);
  if (input.publicationDeployment === undefined || input.packedKaId === undefined) return invalid();
  return input as ConfirmedNamedKaVmLifecycleInput;
}
function normalizeJournalInput(value: unknown): JournalInput {
  const input = record(value);
  if ('tentative' in input) return invalid();
  const assertionVersion = string(input['assertionVersion']);
  if (!/^[1-9][0-9]*$/.test(assertionVersion)) return invalid();
  const packed = input['packedKaId'];
  let packedKaId: bigint | undefined;
  if (packed !== undefined) {
    if (typeof packed !== 'bigint' || packed < 0n || packed >= 1n << 256n) return invalid();
    packedKaId = packed;
  }
  let publicationDeployment: ConfirmedNamedKaVmLifecycleInput['publicationDeployment'] | undefined;
  if (input['publicationDeployment'] !== undefined) {
    const deployment = record(input['publicationDeployment']);
    const chainId = string(deployment['chainId']), lifecycleAddress = string(deployment['lifecycleAddress']);
    if (!/^(0|[1-9][0-9]*)$/.test(chainId) || BigInt(chainId) >= 1n << 256n || !/^0x[0-9a-f]{40}$/i.test(lifecycleAddress)) return invalid();
    publicationDeployment = { chainId, lifecycleAddress: lifecycleAddress.toLowerCase() };
  }
  const normalized = {
    contextGraphId: string(input['contextGraphId']), agentAddress: string(input['agentAddress']), name: string(input['name']),
    publishedUal: string(input['publishedUal']), merkleRoot: root(input['merkleRoot']), assertionVersion,
    ...(input['subGraphName'] === undefined ? {} : { subGraphName: string(input['subGraphName']) }),
    ...(input['priorMerkleRoot'] === undefined ? {} : { priorMerkleRoot: root(input['priorMerkleRoot']) }),
    ...(packedKaId === undefined ? {} : { packedKaId }),
    ...(publicationDeployment === undefined ? {} : { publicationDeployment }),
  };
  if (input['materialization'] === undefined) return normalized;
  if (publicationDeployment === undefined || packedKaId === undefined) return invalid();
  return { ...normalized, materialization: normalizeLifecycleMaterialization(input['materialization'], normalized as ConfirmedKaInput) };
}
export function lifecycleRepairKey(input: JournalInput): string {
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
/** Encode only at the JSON file boundary; worker entries retain confirmed bigint coordinates. */
export function encodeLifecycleRepairJournal(entries: ReadonlyMap<string, LifecycleRepairEntry>): {
  version: 3; entries: Array<[string, Omit<LifecycleRepairEntry, 'input'> & { input: StoredLifecycleRepairInput }]>;
} {
  return { version: 3, entries: [...entries].map(([key, entry]) => {
    const normalized = normalizeJournalInput(entry.input);
    const input: StoredLifecycleRepairInput = { ...normalized, packedKaId: normalized.packedKaId?.toString() };
    const { retention: _retention, ...retry } = entry;
    return [key, { ...retry, input }];
  }) };
}
function decodeLifecycleRepairInput(value: unknown): JournalInput {
  const input = record(value), packed = input['packedKaId'];
  if (packed !== undefined && !/^[0-9]+$/.test(string(packed))) return invalid();
  return normalizeJournalInput({ ...input,
    ...(packed === undefined ? {} : { packedKaId: BigInt(string(packed)) }),
  });
}
export function decodeLifecycleRepairJournal(value: unknown): Map<string, LifecycleRepairEntry> {
  const journal = record(value);
  if ((journal['version'] !== 1 && journal['version'] !== 2 && journal['version'] !== 3) || !Array.isArray(journal['entries'])) return invalid();
  const entries = new Map<string, LifecycleRepairEntry>();
  const storedKeys = new Set<string>();
  for (const tuple of journal['entries']) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string') return invalid();
    const entry = record(tuple[1]); const input = decodeLifecycleRepairInput(entry['input']);
    const key = lifecycleRepairKey(input), attempts = entry['attempts'], nextAttemptAt = entry['nextAttemptAt'];
    const storedKey = journal['version'] === 1 ? historicalRepairKey(input) : key;
    if (tuple[0] !== storedKey || storedKeys.has(storedKey) || entries.has(key) || typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0
      || typeof nextAttemptAt !== 'number' || !Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0
      || (entry['lastError'] !== undefined && typeof entry['lastError'] !== 'string')
      || (entry['rejected'] !== undefined && typeof entry['rejected'] !== 'boolean')) return invalid();
    storedKeys.add(storedKey);
    const evidence = input.publicationDeployment === undefined || input.packedKaId === undefined
      ? { input: input as HistoricalUnboundLifecycleRepairInput, retention: 'historical-unbound' as const }
      : { input: input as ConfirmedKaInput };
    entries.set(key, { ...evidence, attempts, nextAttemptAt,
      ...(entry['lastError'] === undefined ? {} : { lastError: entry['lastError'] }),
      ...(entry['rejected'] === undefined ? {} : { rejected: entry['rejected'] }),
    });
  }
  return entries;
}
