import {
  assertSafeIri,
  assertSafeRdfTerm,
} from '@origintrail-official/dkg-core';

export function unwrapIriTerm(term: string): string {
  return term.startsWith('<') && term.endsWith('>')
    ? term.slice(1, -1)
    : term;
}

export type RdfIriValidator = (value: string, label: string) => string;

const safeIri: RdfIriValidator = (value) => assertSafeIri(value);

export function formatRdfResourceTerm(
  term: string,
  label: string,
  validateIri: RdfIriValidator = safeIri,
): string {
  if (term.startsWith('"')) {
    throw new Error(`${label} must be an IRI`);
  }
  return `<${validateIri(unwrapIriTerm(term), label)}>`;
}

export function formatRdfObjectTerm(
  term: string,
  label: string,
  validateIri: RdfIriValidator = safeIri,
): string {
  if (!term.startsWith('"')) {
    return formatRdfResourceTerm(term, label, validateIri);
  }
  const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
  const normalized = bareDatatype
    ? `${bareDatatype[1]}^^<${validateIri(unwrapIriTerm(bareDatatype[2]), `${label} datatype`)}>`
    : term;
  assertSafeRdfTerm(normalized);
  return normalized;
}
