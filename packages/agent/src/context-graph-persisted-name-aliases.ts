// SPDX-License-Identifier: Apache-2.0

import { projectDormantContextGraphIdentities } from './context-graph-dormant-identity.js';
import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';
import {
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';
import type { ContextGraphMembershipStore, ContextGraphSub, ContextGraphSubscriptionRecord, ContextGraphSubscriptionStore } from './dkg-agent-types.js';

type PersistedNameBinding = Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainHash' | 'onChainId'>;
type ContextGraphNameRetirementIdentity = PersistedNameBinding & Pick<ContextGraphSubscriptionRecord, 'coreHosted'>;

/** Identity verification needs no membership activity or durable sync scope. */
function nameRetirementIdentity(row: PersistedNameBinding) {
  return projectDormantContextGraphIdentities([{
    ...row, subscribed: false, synced: false, syncScoped: false,
  }]).get(row.id);
}


/** Name preimages are aliases only when competing durable rows own one slot. */
export function persistedContextGraphIdAliases(
  rows: readonly PersistedNameBinding[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const placeholders = new Map<string, PersistedNameBinding[]>();
  for (const row of rows) {
    const hash = normalizeContextGraphNameHash(row.id);
    if (hash === null || normalizeContextGraphNameHash(row.onChainHash) !== hash) continue;
    const competing = placeholders.get(hash) ?? [];
    competing.push(row);
    placeholders.set(hash, competing);
  }
  for (const row of rows) {
    const nameHash = normalizeContextGraphNameHash(row.onChainHash);
    if (nameHash === null || row.id.toLowerCase() === nameHash) continue;
    const competing = placeholders.get(nameHash);
    // Equal commitments can name different registry slots. A competing saved
    // placeholder is an alias only when both durable rows prove the same slot.
    if (competing !== undefined && (
      !isCanonicalAuthoritativeContextGraphId(row.onChainId)
      || competing.some((placeholder) => (
        !isCanonicalAuthoritativeContextGraphId(placeholder.onChainId)
        || row.onChainId !== placeholder.onChainId
      ))
    )) continue;
    if (verifyContextGraphNameCandidate(row.id, nameHash) === row.id) aliases.set(nameHash, row.id);
  }
  return aliases;
}

/** Do not rehydrate a placeholder superseded by the same durable numeric slot. */
export function partitionSupersededContextGraphNamePlaceholders<T extends PersistedNameBinding>(
  rows: readonly T[],
): { readonly active: T[]; readonly superseded: T[] } {
  const cleartextByHash = persistedContextGraphIdAliases(rows);
  const active: T[] = [];
  const superseded: T[] = [];
  for (const row of rows) {
    const nameHash = normalizeContextGraphNameHash(row.id);
    const placeholder = nameHash !== null
      && normalizeContextGraphNameHash(row.onChainHash) === nameHash;
    if (placeholder && cleartextByHash.has(nameHash!)) superseded.push(row);
    else active.push(row);
  }
  return { active, superseded };
}


/** Every case variant must prove the committed destination's exact slot. */
export function matchingContextGraphNamePredecessors<T extends ContextGraphNameRetirementIdentity>(
  rows: readonly T[],
  destination: ContextGraphNameRetirementIdentity,
  hostingPreserved: boolean,
  retired?: ContextGraphNameRetirementIdentity,
): T[] | null {
  const identity = nameRetirementIdentity(destination);
  const hash = identity?.onChainHash;
  if (!identity || !hash || hash === destination.id.toLowerCase()) return null;
  const predecessors = rows.filter((row) => typeof row?.id === 'string' && row.id.toLowerCase() === hash);
  const captured = retired && nameRetirementIdentity(retired);
  const capturedHash = captured?.onChainHash;
  return predecessors.some((row) => {
    // Only the exact genuinely retired raw-wire row can supply a legacy missing
    // commitment. A saved hash-shaped key alone has no such authority.
    const repaired = capturedHash !== undefined && row.onChainHash === undefined && row.id === retired?.id
      && capturedHash === normalizeContextGraphNameHash(row.id)
      && captured?.onChainId === row.onChainId;
    const source = nameRetirementIdentity(repaired ? { ...row, onChainHash: capturedHash } : row);
    return !source || source.onChainId !== identity.onChainId || source.onChainHash !== hash
      || (row.coreHosted === true && !hostingPreserved);
  }) ? null : predecessors;
}

/** Durable scalar snapshots are independent of JSON property insertion order. */
export function contextGraphSubscriptionRecordMatches(
  actual: ContextGraphSubscriptionRecord,
  expected: ContextGraphSubscriptionRecord,
): boolean {
  const fields: (keyof ContextGraphSubscriptionRecord)[] = [
    'id', 'name', 'subscribed', 'coreHosted', 'synced', 'sharedMemorySynced',
    'metaSynced', 'syncScoped', 'onChainId', 'onChainHash', 'lastReconciledOrdinal',
  ];
  return fields.every((key) => actual[key] === expected[key]);
}


/** One durable alias migration, using the native membership-before-row lock order. */
export async function retireCommittedContextGraphNamePredecessors(
  destination: ContextGraphNameRetirementIdentity,
  hostingPreserved: boolean,
  retired: ContextGraphNameRetirementIdentity | undefined,
  ports: {
    store: ContextGraphSubscriptionStore;
    membershipStore?: ContextGraphMembershipStore;
    principalId: string;
    destinationCurrent(): boolean;
    queueSubscription(id: string, write: () => Promise<void>): Promise<void>;
    queueMembership(key: string, write: () => Promise<void>): Promise<void>;
    captureSource(row: ContextGraphNameRetirementIdentity): { current(): boolean; complete(): void } | null;
  },
): Promise<void> {
  // Raw wire destinations are leaves; literal hash-shaped names must prove
  // the commitment of their spelling before they can own a migration.
  if (matchingContextGraphNamePredecessors([], destination, hostingPreserved) === null) return;
  if (!ports.destinationCurrent()) return;
  const loaded = await ports.store.loadAll();
  if (!ports.destinationCurrent()) return;
  const predecessors = matchingContextGraphNamePredecessors(loaded, destination, hostingPreserved, retired);
  if (predecessors === null) return;
  const remaining = predecessors.map(row => ({ ...row }));
  const candidates: ContextGraphNameRetirementIdentity[] = [...remaining];
  if (retired && !candidates.some(row => row.id === retired.id)) {
    const qualified = matchingContextGraphNamePredecessors([retired], destination, hostingPreserved);
    if (qualified?.length !== 1) return;
    candidates.push({ ...retired });
  }
  const hash = nameRetirementIdentity(destination)?.onChainHash;
  for (const predecessor of candidates) {
    const source = ports.captureSource(predecessor);
    if (!source) return;
    const current = () => ports.destinationCurrent() && source.current();
    const key = `${predecessor.id}\0node\0${ports.principalId}`;
    await ports.queueMembership(key, () => ports.queueSubscription(predecessor.id, async () => {
      if (!current()) return;
      // Legacy stores cannot prove membership ownership; retire only the saved row.
      if (ports.membershipStore?.loadAll) {
        const members = await ports.membershipStore.loadAll();
        if (!current() || members.some(row => row.contextGraphId === predecessor.id
          && row.principalType === 'node' && row.principalId === ports.principalId
          && row.metadata?.onChainId !== undefined && row.metadata.onChainId !== destination.onChainId)) return;
      }
      const fresh = (await ports.store.loadAll()).filter(row => typeof row?.id === 'string' && row.id.toLowerCase() === hash);
      if (!current() || fresh.length !== remaining.length || remaining.some(expected => {
        const matches = fresh.filter(row => row.id === expected.id);
        return matches.length !== 1 || !contextGraphSubscriptionRecordMatches(matches[0], expected);
      })) return;
      const index = remaining.findIndex(row => row.id === predecessor.id);
      if (index >= 0) {
        await ports.store.delete(predecessor.id);
        if (!current()) return;
        remaining.splice(index, 1);
      }
      if (ports.membershipStore?.loadAll) {
        await ports.membershipStore.delete(predecessor.id, 'node', ports.principalId);
        if (!current()) return;
      }
      source.complete();
    }));
  }
}

/** A live predecessor may be retired only while its runtime remains inactive. */
export function isInactiveContextGraphNamePredecessor(
  source: ContextGraphSub | undefined,
  predecessorId: string,
  destination: ContextGraphNameRetirementIdentity,
): boolean {
  if (!source) return true;
  if (source.subscribed || source.coreHosted) return false;
  const saved = nameRetirementIdentity({ ...source, id: predecessorId });
  const target = nameRetirementIdentity(destination);
  return !!saved && !!target && saved.onChainId === target.onChainId && saved.onChainHash === target.onChainHash;
}


/** Capture the existing native source generation and status callback revision. */
export function captureInactiveContextGraphNamePredecessor(
  row: ContextGraphNameRetirementIdentity,
  destination: ContextGraphNameRetirementIdentity,
  owner: {
    current(id: string): ContextGraphSub | undefined;
    binding: { capture(id: string): number; isGenerationCurrent(id: string, generation: number): boolean };
    nextRevision(id: string): number;
    claimRevision(id: string, revision: number): boolean;
    retireRuntime(id: string): unknown;
    refreshMembership(id: string): void;
    clearStatus(id: string): void;
  },
): { current(): boolean; complete(): void } | null {
  const source = owner.current(row.id);
  const generation = owner.binding.capture(row.id);
  if (!isInactiveContextGraphNamePredecessor(source, row.id, destination)) return null;
  const revision = owner.nextRevision(row.id);
  return {
    current: () => owner.current(row.id) === source && owner.binding.isGenerationCurrent(row.id, generation),
    complete: () => {
      if (source) owner.retireRuntime(row.id);
      owner.refreshMembership(row.id);
      if (owner.claimRevision(row.id, revision)) owner.clearStatus(row.id);
    },
  };
}
