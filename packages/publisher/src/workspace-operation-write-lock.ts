// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';
import { withKeyedLocks } from './keyed-lock.js';
import { normalizeWorkspaceSubGraphName, workspaceOperationSubject } from './workspace-metadata-subjects.js';

export interface WorkspaceOperationWriteLockScope {
  readonly store: TripleStore;
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly shareOperationId: string;
}

const operationWriteLocks = new WeakMap<TripleStore, Map<string, Promise<void>>>();

/** Keep operation ownership stable across raw/KA writers and final retirement reads. */
export function withWorkspaceOperationWriteLock<T>(
  scope: WorkspaceOperationWriteLockScope,
  mutation: () => Promise<T>,
): Promise<T> {
  const operationSubject = workspaceOperationSubject(scope.contextGraphId, scope.shareOperationId);
  const subGraphName = normalizeWorkspaceSubGraphName(scope.subGraphName);
  let locks = operationWriteLocks.get(scope.store);
  if (!locks) {
    locks = new Map();
    operationWriteLocks.set(scope.store, locks);
  }
  return withKeyedLocks(locks, [JSON.stringify([scope.contextGraphId, subGraphName ?? null, operationSubject])], mutation);
}
