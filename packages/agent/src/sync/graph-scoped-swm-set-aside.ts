// SPDX-License-Identifier: Apache-2.0

/**
 * Set aside a defective graph-scoped SWM head instead of every descriptor of
 * its graph.
 *
 * `parseGraphScopedSwmRecoveryDescriptors` throws on the first head that fails
 * validation, so one holder's defective head used to cost a catch-up round
 * every asset of the graph. The shared parser indexes metadata once and decodes each head once,
 * keeping per-head failures separate from graph-wide ownership validation. A conflict between two
 * valid heads still fails the whole graph.
 *
 * Setting a head aside must not certify its asset. A round that sets one aside
 * treats its descriptors as incomplete, exactly as after a failed parse: no
 * snapshot ref resolves by vacuity, the round's bulk metadata stays unwritten
 * and the phase is held incomplete. A ref that one of the set-aside operations
 * names may also belong to an accepted asset with the same content; it stays
 * unresolved, because a resolved ref is not walked again.
 */

import type { SetAsideGraphScopedSwmHead } from './graph-scoped-swm-head-parser.js';

/** A head with no operation may own any ref; otherwise match its source operation. */
export function setAsideHeadsMayOwnRef(
  heads: readonly SetAsideGraphScopedSwmHead[],
  ref: string,
  sourceSubjectsByRef: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const sources = sourceSubjectsByRef.get(ref);
  return heads.some(({ operationSubjects }) => operationSubjects.length === 0
    || operationSubjects.some((subject) => sources?.has(subject)));
}
