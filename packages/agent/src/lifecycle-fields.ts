// SPDX-License-Identifier: Apache-2.0
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

const DKG = 'http://dkg.io/ontology/';

export function lifecycleFields(
  bindings: ReadonlyArray<Readonly<{ p: string; o: string }>>,
  refuse: (reason: string) => never,
) {
  function one(predicate: string): string | undefined {
    const rows = bindings.filter(row => row.p === predicate);
    if (rows.length > 1) return refuse(`conflicting ${predicate} values`);
    return rows[0]?.o;
  }
  function literal(field: string, datatype: 'string' | 'integer' = 'string'): string | undefined {
    const raw = one(DKG + field);
    if (raw === undefined) return undefined;
    const term = parseRdfLiteralTerm(raw);
    if (!term || term.kind === 'language' || (term.kind === 'typed'
      && term.datatype !== 'http://www.w3.org/2001/XMLSchema#' + datatype)) return refuse(`invalid ${field} literal`);
    return term.value;
  }
  return { one, literal };
}
