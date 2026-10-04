// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { createHash } from 'node:crypto';
import { assertionLifecycleWriteLockKey } from '@origintrail-official/dkg-publisher';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';
export type StoredLifecycleRepairInput = Omit<ConfirmedNamedKaVmLifecycleInput, 'packedKaId' | 'tentative'> & { packedKaId?: string };
export interface LifecycleRepairEntry {
  input: ConfirmedNamedKaVmLifecycleInput;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  rejected?: boolean;
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
function root(value: unknown): string {
  const text = string(value);
  if (!/^(0x)?[0-9a-f]{64}$/i.test(text)) return invalid();
  return text.toLowerCase().replace(/^0x/, '');
}
export function normalizeLifecycleRepairInput(value: unknown): ConfirmedNamedKaVmLifecycleInput {
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
  let publicationDeployment: ConfirmedNamedKaVmLifecycleInput['publicationDeployment'];
  if (input['publicationDeployment'] !== undefined) {
    const deployment = record(input['publicationDeployment']);
    const chainId = string(deployment['chainId']), lifecycleAddress = string(deployment['lifecycleAddress']);
    if (!/^(0|[1-9][0-9]*)$/.test(chainId) || BigInt(chainId) >= 1n << 256n || !/^0x[0-9a-f]{40}$/i.test(lifecycleAddress)) return invalid();
    publicationDeployment = { chainId, lifecycleAddress: lifecycleAddress.toLowerCase() };
  }
  return {
    contextGraphId: string(input['contextGraphId']), agentAddress: string(input['agentAddress']), name: string(input['name']),
    publishedUal: string(input['publishedUal']), merkleRoot: root(input['merkleRoot']), assertionVersion,
    ...(input['subGraphName'] === undefined ? {} : { subGraphName: string(input['subGraphName']) }),
    ...(input['priorMerkleRoot'] === undefined ? {} : { priorMerkleRoot: root(input['priorMerkleRoot']) }),
    ...(packedKaId === undefined ? {} : { packedKaId }),
    ...(publicationDeployment === undefined ? {} : { publicationDeployment }),
  };
}
export function lifecycleRepairKey(input: ConfirmedNamedKaVmLifecycleInput): string {
  const hash = createHash('sha256').update(assertionLifecycleWriteLockKey(
    input.contextGraphId, input.name, input.agentAddress, input.subGraphName,
  ));
  // Unbound historical entries keep their exact original key. Distinct deployments
  // share the KA write fence but must never overwrite each other's repair evidence.
  if (input.publicationDeployment) hash.update(JSON.stringify([input.publicationDeployment.chainId, input.publicationDeployment.lifecycleAddress.toLowerCase()]));
  return hash.digest('hex');
}
// Read-only compatibility with the original journal encoding. New writes use
// the publisher's identity contract; validate the old key before migrating it.
function historicalRepairKey(input: ConfirmedNamedKaVmLifecycleInput): string {
  return createHash('sha256').update(JSON.stringify([input.contextGraphId, input.agentAddress.toLowerCase(), input.name, input.subGraphName ?? ''])).digest('hex');
}
/** Encode only at the JSON file boundary; worker entries retain confirmed bigint coordinates. */
export function encodeLifecycleRepairJournal(entries: ReadonlyMap<string, LifecycleRepairEntry>): {
  version: 2; entries: Array<[string, Omit<LifecycleRepairEntry, 'input'> & { input: StoredLifecycleRepairInput }]>;
} {
  return { version: 2, entries: [...entries].map(([key, entry]) => {
    const normalized = normalizeLifecycleRepairInput(entry.input);
    const input: StoredLifecycleRepairInput = { ...normalized, packedKaId: normalized.packedKaId?.toString() };
    return [key, { ...entry, input }];
  }) };
}
function decodeLifecycleRepairInput(value: unknown): ConfirmedNamedKaVmLifecycleInput {
  const input = record(value), packed = input['packedKaId'];
  if (packed !== undefined && !/^[0-9]+$/.test(string(packed))) return invalid();
  return normalizeLifecycleRepairInput({ ...input,
    ...(packed === undefined ? {} : { packedKaId: BigInt(string(packed)) }),
  });
}
export function decodeLifecycleRepairJournal(value: unknown): Map<string, LifecycleRepairEntry> {
  const journal = record(value);
  if ((journal['version'] !== 1 && journal['version'] !== 2) || !Array.isArray(journal['entries'])) return invalid();
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
    entries.set(key, { input, attempts, nextAttemptAt,
      ...(entry['lastError'] === undefined ? {} : { lastError: entry['lastError'] }),
      ...(entry['rejected'] === undefined ? {} : { rejected: entry['rejected'] }),
    });
  }
  return entries;
}
