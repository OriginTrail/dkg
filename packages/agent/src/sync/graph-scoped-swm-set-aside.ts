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

import { parseGraphScopedSwmRecoveryHeadResults, type GraphScopedSwmRecoveryParseInput,
  type GraphScopedSwmRecoveryDescriptor } from './graph-scoped-swm-recovery.js';
import type { SetAsideGraphScopedSwmHead } from './graph-scoped-swm-head-parser.js';
export type { SetAsideGraphScopedSwmHead } from './graph-scoped-swm-head-parser.js';

type ParseParams = GraphScopedSwmRecoveryParseInput;
export const parseGraphScopedSwmRecoveryDescriptorsSettingAside = parseGraphScopedSwmRecoveryHeadResults;

/** One round's set-aside heads, and the snapshot refs they may own. */
export class SetAsideGraphScopedSwmHeads {
  #heads: readonly SetAsideGraphScopedSwmHead[] = [];

  constructor(private readonly warn: (message: string) => void) {}

  /** Parse, setting each defective head aside with a warning. */
  parse(params: ParseParams): GraphScopedSwmRecoveryDescriptor[] {
    const { descriptors, setAside } = parseGraphScopedSwmRecoveryDescriptorsSettingAside(params);
    this.#heads = setAside;
    const [first] = setAside;
    if (first) {
      this.warn(`SWM sync set aside ${setAside.length} graph-scoped head(s) for "${params.contextGraphId}" `
        + `and kept ${descriptors.length}: ${first.headSubject}: ${first.error.message}`);
    }
    return descriptors;
  }

  /** Whether the last parse set any head aside. */
  get any(): boolean {
    return this.#heads.length > 0;
  }

  /**
   * Whether `ref` may hold a set-aside asset: a set-aside head names an
   * operation it was read from, or names no operation at all.
   */
  mayOwn(ref: string, sourceSubjectsByRef: ReadonlyMap<string, ReadonlySet<string>>): boolean {
    const sources = sourceSubjectsByRef.get(ref);
    return this.#heads.some(({ operationSubjects }) => operationSubjects.length === 0
      || operationSubjects.some((subject) => sources?.has(subject)));
  }
}

