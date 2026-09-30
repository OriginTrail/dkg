import {
  formatCanonicalRdfLiteralTerm,
  isAbsoluteRfc3987IriV1,
  type RdfTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { isSafeIri } from '@origintrail-official/dkg-core';

const MAX_CACHED_IRI_VARIABLES = 128;
const MAX_CACHED_IRI_LENGTH = 1024;
const MAX_CONSECUTIVE_IRI_MISSES = 16;
const PAUSED_IRI_COMPARISON_ROWS = 128;
const SCHEME_ONLY_IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:$/;

export type SparqlResultTerm = RdfTerm;

export type SparqlResultReject = (message: string) => never;

type IriValidator = (value: string) => boolean;

/** Transport-neutral normalization and bounded IRI validation for SELECT rows. */
export class SparqlSelectResultNormalizer {
  private readonly iriValidators: IriValidator[];
  private readonly datatypeValidators: IriValidator[];

  constructor(
    variableCount: number,
    multipleRows: boolean,
    private readonly reject: SparqlResultReject,
  ) {
    const cachedColumns = multipleRows
      ? Math.min(variableCount, MAX_CACHED_IRI_VARIABLES)
      : 0;
    this.iriValidators = Array.from({ length: cachedColumns }, createIriValidator);
    this.datatypeValidators = Array.from({ length: cachedColumns }, createIriValidator);
  }

  format(term: SparqlResultTerm, column: number, label: string): string {
    if (term.kind === 'iri') return this.formatIri(term.value, column, label);
    if (term.kind === 'blank-node') return `_:${term.value}`;
    if (term.value.kind === 'typed') {
      this.assertDatatypeIri(term.value.datatype, column, label);
    }
    return formatCanonicalRdfLiteralTerm(term.value);
  }

  assertDatatypeIri(value: string, column: number, label: string): void {
    const validate = this.datatypeValidators[column] ?? isSafeResultIri;
    if (!validate(value)) {
      this.reject(`${label} datatype must be an absolute safe IRI`);
    }
  }

  /** Hot-path entry point for wire decoders that already isolated an IRIREF. */
  formatIri(value: string, column: number, label: string): string {
    const validate = this.iriValidators[column] ?? isSafeResultIri;
    if (!validate(value)) {
      this.reject(`${label} URI value must be an absolute safe IRI`);
    }
    return value;
  }

  set(binding: Record<string, string>, variable: string, value: string): void {
    // `__proto__` is a legal SPARQL variable; ordinary assignment would invoke
    // the inherited setter and silently drop it or change the row prototype.
    if (variable === '__proto__') {
      Object.defineProperty(binding, '__proto__', {
        value, writable: true, enumerable: true, configurable: true,
      });
    } else {
      binding[variable] = value;
    }
  }
}

/** One RFC 3987 policy for optimized and grammar-backed result IRIs. */
export function isSafeResultIri(value: string): boolean {
  return isSafeResultIriPolicy(value) && isAbsoluteRfc3987IriV1(value);
}

function isSafeResultIriPolicy(value: string): boolean {
  return isSafeIri(value) || SCHEME_ONLY_IRI.test(value);
}

/** One last successful value per column role, never a growing response cache. */
function createIriValidator(): IriValidator {
  return createCachedIriValidator(isSafeResultIri);
}

function createCachedIriValidator(validateIri: IriValidator): IriValidator {
  let lastValidIri: string | undefined;
  let consecutiveMisses = 0;
  let pausedRows = 0;
  return value => {
    if (pausedRows > 0) {
      pausedRows -= 1;
      return validateIri(value);
    }
    if (value === lastValidIri) {
      consecutiveMisses = 0;
      return true;
    }
    const valid = validateIri(value);
    if (valid && value.length <= MAX_CACHED_IRI_LENGTH) lastValidIri = value;
    consecutiveMisses += 1;
    if (consecutiveMisses >= MAX_CONSECUTIVE_IRI_MISSES) {
      pausedRows = PAUSED_IRI_COMPARISON_ROWS;
      consecutiveMisses = 0;
      lastValidIri = undefined;
    }
    return valid;
  };
}
