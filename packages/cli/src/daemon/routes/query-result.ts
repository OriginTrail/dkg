// SPDX-License-Identifier: Apache-2.0

import { classifySparqlOperation } from '@origintrail-official/dkg-core';

type LegacyApiQueryResult = {
  bindings: Array<Record<string, string>>;
  quads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
};

export type PublicApiQueryResult = import('@origintrail-official/dkg-core').PublicQueryResult<
  Record<string, string>,
  { subject: string; predicate: string; object: string; graph: string }
>;

/** Normalize the legacy engine shape at the public daemon boundary. */
export function normalizePublicApiQueryResult(
  sparql: string,
  result: LegacyApiQueryResult,
): PublicApiQueryResult {
  const operation = classifySparqlOperation(sparql);
  if (operation.kind === 'read' && (operation.form === 'CONSTRUCT' || operation.form === 'DESCRIBE')) {
    return { type: 'quads', quads: result.quads ?? [], bindings: [] };
  }
  if (operation.kind === 'read' && operation.form === 'ASK') {
    const raw = result.bindings[0]?.result;
    const value = String(raw).toLowerCase() === 'true';
    return { type: 'boolean', value, bindings: [{ result: String(value) }] };
  }
  return { type: 'bindings', bindings: result.bindings };
}
