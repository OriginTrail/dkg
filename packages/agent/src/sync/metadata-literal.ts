import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

export function stripMetadataLiteral(value: string): string;
export function stripMetadataLiteral(value: undefined): undefined;
export function stripMetadataLiteral(value: string | undefined): string | undefined;
/** Preserve existing non-literal inputs while sharing the canonical RDF decoder. */
export function stripMetadataLiteral(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseRdfLiteralTerm(value)?.value ?? value;
}
