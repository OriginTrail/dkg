export type DkgQuad = {
  subject: string;
  predicate: string;
  object: string;
};

export const NS: Record<string, string>;
export const XSD: Record<string, string>;
export const Common: Record<string, string>;

export function uri(value: string): string;
export function lit(value: unknown, datatype?: string | null, lang?: string | null): string;
export function iriObject(value: string): string;
export function literalObject(value: unknown): string;
export function typedLiteralObject(value: unknown, datatypeIri: string): string;

export function buildProjectOntologyTriples(args: {
  contextGraphId: string;
  starterSlug: string;
  ttl: string;
  guide: string;
  nowIso?: string;
}): {
  ontologyUri: string;
  guideUri: string;
  quads: DkgQuad[];
};

export function createTripleSink(): {
  triples: DkgQuad[];
  emit(subject: string, predicate: string, object: string): void;
  size(): number;
};
