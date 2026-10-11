// The quad contract of the Knowledge Asset write routes, `POST
// /api/knowledge-assets` (create) and `POST /api/knowledge-assets/{name}/wm/write`.
// The API client sends these quads, and the daemon checks every one against
// this contract before any write (`daemon/knowledge-asset-quad-validation.ts`).

import type { WritableRdfTerm } from '@origintrail-official/dkg-rdf-utils';

export interface KnowledgeAssetWritableQuad {
  subject: string;
  predicate: string;
  object: string;
  /** Optional: empty or a bare absolute RFC 3987 IRI. */
  graph?: string;
}

export type WritableTermKind = WritableRdfTerm['kind'];

/**
 * The term kinds each quad position accepts, as rdf-utils'
 * `parseWritableRdfTerm` reads them. Terms are checked exactly as sent, since
 * nothing downstream trims them. An IRI must be an absolute RFC 3987 IRI, bare
 * or in angle brackets. The object accepts every kind, so its check is that the
 * term is well-formed.
 */
export const WRITABLE_QUAD_TERMS: Readonly<Record<'subject' | 'predicate' | 'object', {
  readonly accepts: readonly WritableTermKind[];
  readonly expected: string;
}>> = {
  subject: { accepts: ['iri', 'blank-node'], expected: 'an absolute IRI or blank node' },
  predicate: { accepts: ['iri'], expected: 'an absolute IRI' },
  object: {
    accepts: ['literal', 'iri', 'blank-node'],
    expected: 'a quoted literal term, absolute IRI or blank node',
  },
};
