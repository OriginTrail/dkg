// SPDX-License-Identifier: Apache-2.0
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { assertionLifecycleWriteLockKey, isPublishedAssertionOwner } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ConfirmedNamedKaVmLifecycleInput, NamedKaVmLifecycleRepair } from './named-ka-vm-lifecycle-repair.js';

/** Admit confirmed evidence immediately; replay retains the canonical publisher lock domain. */
export async function submitOwnedNamedKaVmLifecycleRepair(
  store: TripleStore, writeLocks: Map<string, Promise<void>>, owner: NamedKaVmLifecycleRepair,
  input: ConfirmedNamedKaVmLifecycleInput,
) {
  const owned = input.publicationShareOperationId === undefined || await isPublishedAssertionOwner(store,
    contextGraphMetaUri(input.contextGraphId), assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName),
    input.publicationShareOperationId);
  // A negative ownership check must not wait on a replacement's held curator
  // confirmation. Once that writer retires, the same owner repairs permanent
  // history while the planner continues to protect the replacement workspace.
  return owner.submit(input, { deferExecution: !owned && writeLocks.has(
    assertionLifecycleWriteLockKey(input.contextGraphId, input.name, input.agentAddress, input.subGraphName),
  ) });
}
