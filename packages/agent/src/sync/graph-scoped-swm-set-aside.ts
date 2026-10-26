// SPDX-License-Identifier: Apache-2.0

/**
 * Set aside a defective graph-scoped SWM head instead of every descriptor of
 * its graph.
 *
 * `parseGraphScopedSwmRecoveryDescriptors` throws on the first head that fails
 * validation, so one holder's defective head used to cost a catch-up round
 * every asset of the graph. Each head is validated from its own rows and the
 * rows of the operations it names, so a failing head can be parsed alone and
 * dropped while the rest of the graph parses as before. A conflict between two
 * valid heads still fails the whole graph.
 *
 * Setting a head aside must not certify its asset. A round that sets one aside
 * treats its descriptors as incomplete, exactly as after a failed parse: no
 * snapshot ref resolves by vacuity, the round's bulk metadata stays unwritten
 * and the phase is held incomplete. A ref that one of the set-aside operations
 * names may also belong to an accepted asset with the same content; it stays
 * unresolved, because a resolved ref is not walked again.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import {
  parseGraphScopedSwmRecoveryDescriptors,
  type GraphScopedSwmRecoveryDescriptor,
} from './graph-scoped-swm-recovery.js';
import { stripMetadataLiteral } from './metadata-literal.js';

type ParseParams = Parameters<typeof parseGraphScopedSwmRecoveryDescriptors>[0];

const HEAD_SUFFIX = '#dkg-swm-head';
const SHARE_OPERATION_ID = 'http://dkg.io/ontology/shareOperationId';

/** A head that failed validation, kept out of the descriptors with its error. */
export interface SetAsideGraphScopedSwmHead {
  readonly metaGraph: string;
  readonly headSubject: string;
  /** The operation subjects the head names; empty when it names none. */
  readonly operationSubjects: readonly string[];
  readonly error: Error;
}

/**
 * The descriptors of every head that validates, and the heads that do not.
 * Throws only what fails the graph as a whole.
 */
export function parseGraphScopedSwmRecoveryDescriptorsSettingAside(params: ParseParams): {
  descriptors: GraphScopedSwmRecoveryDescriptor[];
  setAside: SetAsideGraphScopedSwmHead[];
} {
  try {
    return { descriptors: parseGraphScopedSwmRecoveryDescriptors(params), setAside: [] };
  } catch (graphError) {
    const setAside = defectiveHeads(params);
    if (setAside.length === 0) throw graphError;
    const setAsideKeys = new Set(setAside.map(({ metaGraph, headSubject }) => `${metaGraph}\u0000${headSubject}`));
    const descriptors = parseGraphScopedSwmRecoveryDescriptors({
      ...params,
      metaQuads: params.metaQuads.filter((quad) => !setAsideKeys.has(`${quad.graph}\u0000${quad.subject}`)),
    });
    return { descriptors, setAside };
  }
}

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

/** Every head that fails when parsed alone with the operations it names. */
function defectiveHeads(params: ParseParams): SetAsideGraphScopedSwmHead[] {
  const bySubject = new Map<string, Quad[]>();
  for (const quad of params.metaQuads) {
    const key = `${quad.graph}\u0000${quad.subject}`;
    const rows = bySubject.get(key);
    if (rows) rows.push(quad);
    else bySubject.set(key, [quad]);
  }
  const setAside: SetAsideGraphScopedSwmHead[] = [];
  for (const [key, headRows] of bySubject) {
    const separator = key.indexOf('\u0000');
    const metaGraph = key.slice(0, separator);
    const headSubject = key.slice(separator + 1);
    if (!headSubject.endsWith(HEAD_SUFFIX)) continue;
    const operationSubjects = [...new Set(headRows
      .filter((quad) => quad.predicate === SHARE_OPERATION_ID)
      .map((quad) => stripMetadataLiteral(quad.object).trim())
      .filter((shareOperationId) => shareOperationId.length > 0)
      .map((shareOperationId) => `urn:dkg:share:${params.contextGraphId}:${shareOperationId}`))];
    try {
      parseGraphScopedSwmRecoveryDescriptors({
        ...params,
        metaQuads: [
          ...headRows,
          ...operationSubjects.flatMap((subject) => bySubject.get(`${metaGraph}\u0000${subject}`) ?? []),
        ],
      });
    } catch (error) {
      setAside.push({
        metaGraph,
        headSubject,
        operationSubjects,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return setAside;
}
