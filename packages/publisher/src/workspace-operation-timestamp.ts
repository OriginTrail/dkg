// SPDX-License-Identifier: Apache-2.0
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

/** Shared RDF decoding; callers choose their boundary's rejection or repair policy. */
export function decodeWorkspaceOperationTimestamp(term: string): number {
  return Date.parse((parseRdfLiteralTerm(term)?.value ?? term).trim());
}

/** The publisher resolver only exposes nonnegative, exact millisecond timestamps. */
export function isResolverWorkspaceOperationTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Missing stamps stay absent; any invalid stamp poisons the result. */
export function earliestWorkspaceOperationTimestamp(terms: readonly string[]): number | undefined {
  return terms.length === 0 ? undefined : terms.reduce(
    (earliest, term) => Math.min(earliest, decodeWorkspaceOperationTimestamp(term)),
    Number.POSITIVE_INFINITY,
  );
}
