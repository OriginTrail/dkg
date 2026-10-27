import { DKG_RDF_LITERAL_SAFE_MUTF8_BYTES, javaModifiedUtf8ByteLength } from '@origintrail-official/dkg-rdf-utils';
import { DKGUserError } from './errors.js';

// The limit and its measure are shared with writers that split text below it (`dkg-rdf-utils`).
export { DKG_RDF_LITERAL_SAFE_MUTF8_BYTES, javaModifiedUtf8ByteLength };
export const JAVA_WRITE_UTF_MAX_BYTES = 65_535;
export const OVERSIZED_RDF_LITERAL_ERROR_CODE = 'OVERSIZED_RDF_LITERAL';

export interface RdfLiteralSizeContext {
  readonly label?: string;
  readonly subject?: string;
  readonly predicate?: string;
  readonly graph?: string;
  readonly maxBytes?: number;
}

export interface QuadLiteralLike {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph?: string;
}

export class OversizedRdfLiteralError extends DKGUserError {
  readonly code = OVERSIZED_RDF_LITERAL_ERROR_CODE;
  readonly actualBytes: number;
  readonly maxBytes: number;
  readonly subject?: string;
  readonly predicate?: string;
  readonly graph?: string;
  readonly label?: string;

  constructor(args: {
    actualBytes: number;
    maxBytes: number;
    label?: string;
    subject?: string;
    predicate?: string;
    graph?: string;
  }) {
    const location = describeLiteralLocation(args);
    super(
      `RDF literal${location} is ${args.actualBytes} Java MUTF-8 bytes, ` +
      `which exceeds the Blazegraph-compatible safe limit of ${args.maxBytes} bytes. ` +
      `Split large text into ordered chunks below the limit, or store the body externally ` +
      `and publish only its URI, hash, summary, and metadata. ` +
      `See docs/use-dkg/large-content.md for the supported patterns and roadmap.`,
    );
    this.name = 'OversizedRdfLiteralError';
    this.actualBytes = args.actualBytes;
    this.maxBytes = args.maxBytes;
    this.label = args.label;
    this.subject = args.subject;
    this.predicate = args.predicate;
    this.graph = args.graph;
  }
}

function describeLiteralLocation(args: {
  label?: string;
  subject?: string;
  predicate?: string;
  graph?: string;
}): string {
  const parts: string[] = [];
  if (args.label) parts.push(args.label);
  if (args.subject) parts.push(`subject=${truncateForMessage(args.subject)}`);
  if (args.predicate) parts.push(`predicate=${truncateForMessage(args.predicate)}`);
  if (args.graph) parts.push(`graph=${truncateForMessage(args.graph)}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function truncateForMessage(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

export function rdfLiteralTermMutf8ByteLength(term: string): number | undefined {
  if (!term.startsWith('"')) return undefined;
  return javaModifiedUtf8ByteLength(term);
}

export function isOversizedRdfLiteralError(err: unknown): err is OversizedRdfLiteralError {
  if (err instanceof OversizedRdfLiteralError) return true;
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === OVERSIZED_RDF_LITERAL_ERROR_CODE;
}

export function assertRdfLiteralMutf8Safe(
  term: string,
  options: RdfLiteralSizeContext = {},
): void {
  const actualBytes = rdfLiteralTermMutf8ByteLength(term);
  if (actualBytes === undefined) return;
  const maxBytes = options.maxBytes ?? DKG_RDF_LITERAL_SAFE_MUTF8_BYTES;
  if (actualBytes <= maxBytes) return;
  throw new OversizedRdfLiteralError({
    actualBytes,
    maxBytes,
    label: options.label,
    subject: options.subject,
    predicate: options.predicate,
    graph: options.graph,
  });
}

export function assertQuadLiteralsMutf8Safe(
  quads: readonly QuadLiteralLike[],
  options: Pick<RdfLiteralSizeContext, 'label' | 'maxBytes'> = {},
): void {
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    assertRdfLiteralMutf8Safe(q.object, {
      maxBytes: options.maxBytes,
      label: options.label ? `${options.label}[${i}].object` : `quads[${i}].object`,
      subject: q.subject,
      predicate: q.predicate,
      graph: q.graph,
    });
  }
}
