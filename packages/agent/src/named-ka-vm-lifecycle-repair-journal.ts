// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { assertionLifecycleWriteLockKey } from '@origintrail-official/dkg-publisher';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';
export type StoredLifecycleRepairInput = Omit<ConfirmedNamedKaVmLifecycleInput, 'packedKaId'> & { packedKaId?: string };
export interface LifecycleRepairEntry {
  input: StoredLifecycleRepairInput;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  rejected?: boolean;
}
function invalid(): never {
  throw Object.assign(new Error('Invalid confirmed named KA lifecycle repair evidence'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
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
export function normalizeLifecycleRepairInput(value: unknown, submission = false): StoredLifecycleRepairInput {
  const input = record(value);
  const assertionVersion = string(input['assertionVersion']);
  if (!/^[1-9][0-9]*$/.test(assertionVersion)) return invalid();
  const packed = input['packedKaId'];
  let packedKaId: string | undefined;
  if (packed !== undefined) {
    packedKaId = submission && typeof packed === 'bigint' ? packed.toString() : string(packed);
    if (!/^[0-9]+$/.test(packedKaId) || BigInt(packedKaId) >= 1n << 256n) return invalid();
    packedKaId = BigInt(packedKaId).toString();
  }
  return {
    contextGraphId: string(input['contextGraphId']), agentAddress: string(input['agentAddress']), name: string(input['name']),
    publishedUal: string(input['publishedUal']), merkleRoot: root(input['merkleRoot']), assertionVersion,
    ...(input['subGraphName'] === undefined ? {} : { subGraphName: string(input['subGraphName']) }),
    ...(input['priorMerkleRoot'] === undefined ? {} : { priorMerkleRoot: root(input['priorMerkleRoot']) }),
    ...(packedKaId === undefined ? {} : { packedKaId }),
  };
}
export function lifecycleRepairKey(input: StoredLifecycleRepairInput): string {
  return createHash('sha256').update(assertionLifecycleWriteLockKey(
    input.contextGraphId, input.name, input.agentAddress, input.subGraphName,
  )).digest('hex');
}
// Read-only compatibility with the original journal encoding. New writes use
// the publisher's identity contract; validate the old key before migrating it.
function historicalRepairKey(input: StoredLifecycleRepairInput): string {
  return createHash('sha256').update(JSON.stringify([input.contextGraphId, input.agentAddress.toLowerCase(), input.name, input.subGraphName ?? ''])).digest('hex');
}
export function decodeLifecycleRepairJournal(value: unknown): Map<string, LifecycleRepairEntry> {
  const journal = record(value);
  if ((journal['version'] !== 1 && journal['version'] !== 2) || !Array.isArray(journal['entries'])) return invalid();
  const entries = new Map<string, LifecycleRepairEntry>();
  const storedKeys = new Set<string>();
  for (const tuple of journal['entries']) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string') return invalid();
    const entry = record(tuple[1]); const input = normalizeLifecycleRepairInput(entry['input']);
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
