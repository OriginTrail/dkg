// SPDX-License-Identifier: Apache-2.0
import { validateContextGraphId } from '@origintrail-official/dkg-core';

/** Why a sync request's context graph id is refused before authorization reads anything. */
export type SyncContextGraphIdRefusal =
  | 'invalid-context-graph-id'
  | 'reserved-partition-segment'
  | 'nested-context-graph-id';

/**
 * Whether a sync request may name this context graph id at all.
 *
 * A responder serves the graph `did:dkg:context-graph:<id>` and the graphs under it, so the id is
 * also a path into the storage namespace. Two kinds of id name graphs that belong to another
 * context graph:
 *
 * - An id with a reserved partition segment (`_meta`, `_private`, `_shared_memory`, …). No new
 *   context graph id may have one (`validateNewContextGraphId`), so `<id>/_private` names the
 *   private partition of `<id>`.
 * - An id under a context graph this node keeps. `<id>/<name>` and `<id>/context/<n>` are that
 *   context graph's sub-graphs, guarded by its policy.
 *
 * Both are refused unless this node keeps that exact id itself: an admitted subscription or a local
 * create, never anything a peer can write. A reserved segment is refused even then if a shorter id
 * is also kept, because its graphs are that context graph's partitions.
 *
 * `keepsContextGraphLocally` must not read the store: it runs before authorization, on ids any
 * peer can send.
 */
export function syncContextGraphIdRefusal(
  contextGraphId: unknown,
  keepsContextGraphLocally: (contextGraphId: string) => boolean,
): SyncContextGraphIdRefusal | undefined {
  if (!validateContextGraphId(contextGraphId).valid) return 'invalid-context-graph-id';
  const id = contextGraphId as string;
  const segments = id.split('/');

  let keepsShorterId = false;
  let prefix = '';
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix = index === 0 ? segments[0] : `${prefix}/${segments[index]}`;
    if (keepsContextGraphLocally(prefix)) {
      keepsShorterId = true;
      break;
    }
  }
  const keepsExactId = keepsContextGraphLocally(id);

  if (segments.some((segment) => segment.startsWith('_'))) {
    return keepsExactId && !keepsShorterId ? undefined : 'reserved-partition-segment';
  }
  if (keepsShorterId && !keepsExactId) return 'nested-context-graph-id';
  return undefined;
}
