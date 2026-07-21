export type WalRdfErrorCode =
  | 'WAL_RDF_INVALID_NQUADS'
  | 'WAL_RDF_NON_CANONICAL'
  | 'WAL_RDF_BLANK_NODE'
  | 'WAL_RDF_IRI_INVALID'
  | 'WAL_RDF_LIMIT_EXCEEDED'
  | 'WAL_RDF_SCOPE_ESCAPE'
  | 'WAL_RDF_POLICY_INVALID'
  | 'WAL_RDF_POLICY_SUBSTITUTION'
  | 'WAL_RDF_ADAPTER_VERSION'
  | 'WAL_RDF_UNAUTHORIZED'
  | 'WAL_RDF_BASE_MISMATCH'
  | 'WAL_RDF_RESULT_MISMATCH'
  | 'WAL_RDF_TOUCHED_KEYS_MISMATCH'
  | 'WAL_RDF_CAUSAL_RELATION'
  | 'WAL_RDF_OBJECT_TOO_LARGE';

export class WalRdfError extends Error {
  readonly code: WalRdfErrorCode;
  readonly cause?: unknown;

  constructor(code: WalRdfErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'WalRdfError';
    this.code = code;
    this.cause = cause;
  }
}

export function rdfError(code: WalRdfErrorCode, message: string, cause?: unknown): never {
  throw new WalRdfError(code, message, cause);
}
