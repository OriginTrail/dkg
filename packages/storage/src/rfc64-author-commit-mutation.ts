import type { Quad } from './triple-store.js';
import {
  normalizeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasInputV1,
} from './rfc64-author-commit-cas.js';

/** What an author commit replaces and what it inserts, for an observer that has to fence the facts it touches. */
export interface Rfc64AuthorCommitMutationV1 {
  /** Every graph, subject or predicate the commit replaces. */
  readonly removals: readonly {
    readonly graph: string;
    readonly subject?: string;
    readonly predicate?: string;
  }[];
  /** Every quad it inserts. */
  readonly quads: readonly Quad[];
}

/** Summarize a commit from the canonical plan, without exposing the plan itself. */
export function describeRfc64AuthorCommitCasV1(
  input: Rfc64AuthorCommitCasInputV1,
): Rfc64AuthorCommitMutationV1 {
  const plan = normalizeRfc64AuthorCommitCasV1(input);
  return Object.freeze({
    removals: Object.freeze([
      ...plan.graphReplacements.map(({ graphUri }) => ({ graph: graphUri })),
      ...plan.subjectReplacements.map(({ graphUri, subject }) => ({ graph: graphUri, subject })),
      ...plan.predicateReplacements.map(({ graphUri, subject, predicate }) => ({ graph: graphUri, subject, predicate })),
    ]),
    quads: plan.semanticQuads,
  });
}
