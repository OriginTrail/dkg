// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a store holds exactly the projection that was written to it.
 *
 * A verified projection is in the protocol's canonical term form. What a
 * store returns for it can differ from that form in two ways, and neither is
 * a change of content:
 *
 * - A character returned escaped. The canonical form keeps a tab and the
 *   other control characters as they are; the store adapters return `\t`,
 *   `\b`, `\f` or `\uXXXX` for them, on every store.
 * - A typed literal in the store's own lexical form of the same value.
 *   Blazegraph returns the xsd:dateTime `"2026-01-01T00:00:00Z"` as
 *   `"2026-01-01T00:00:00.000Z"` and the xsd:double `"100"` as `"100.0"`;
 *   Oxigraph returns the canonical form.
 *
 * A read-back that was held to the projection's own bytes and compared with
 * it term for term therefore failed for an asset with such a typed literal
 * on a Blazegraph node, and would fail for a literal with a tab on every
 * node. The asset was never activated there.
 *
 * The read-back is compared in the canonical term form instead, the form the
 * protocol hashes into a Merkle leaf: two triples equal in it are the same
 * triple to every node, whatever store it runs. A term that differs in any
 * other way still fails. The removal of a catalog row compares the same way
 * (`catalog-semantic-authority-transition-v1.ts`).
 */

import { encodeCanonicalCgSharedPublicRootProjectionV1 } from '@origintrail-official/dkg-core';
import { quadToNQuad, type Quad } from '@origintrail-official/dkg-storage';

/** Bytes one escaped character may add: `\uXXXX` in place of a single byte. */
export const STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1 = 5;
/**
 * Bytes a store's own lexical form may add to one triple's canonical form.
 * The forms met so far add at most five (`.000Z` on a zone-less xsd:dateTime).
 */
export const STORE_LEXICAL_FORM_ALLOWANCE_BYTES_PER_TRIPLE_V1 = 64;

/**
 * The byte limit for reading back the canonical `projectionText` of
 * `tripleCount` triples: its own bytes, an allowance for every character a
 * store may return escaped, and one for every triple. It stays proportional
 * to what was written, and the read is already limited to `tripleCount` rows.
 */
export function projectionReadBackByteLimitV1(
  projectionText: string,
  tripleCount: number,
): number {
  let escapable = 0;
  for (let index = 0; index < projectionText.length; index += 1) {
    const unit = projectionText.charCodeAt(index);
    // A line feed ends a canonical line; inside a literal it is already escaped.
    if (unit !== 0x0a && (unit < 0x20 || unit >= 0x7f)) escapable += 1;
  }
  return Buffer.byteLength(projectionText, 'utf8')
    + escapable * STORE_ESCAPE_ALLOWANCE_BYTES_PER_CHARACTER_V1
    + tripleCount * STORE_LEXICAL_FORM_ALLOWANCE_BYTES_PER_TRIPLE_V1;
}

/**
 * True when `readBack` holds the triples of `projection` and no other: either
 * term for term as the store returned them, in any order, or after both are
 * put in the canonical term form. Graph names are not compared; the caller
 * read one graph.
 */
export function readBackHoldsProjectionV1(
  projection: readonly Readonly<Quad>[],
  readBack: readonly Readonly<Quad>[],
): boolean {
  if (projection.length !== readBack.length) return false;
  if (sortedStoreTermsV1(projection) === sortedStoreTermsV1(readBack)) return true;
  // The canonical form leaves a term it does not know as it is, so such a term
  // still has to match character for character.
  return equalBytes(
    encodeCanonicalCgSharedPublicRootProjectionV1(projection),
    encodeCanonicalCgSharedPublicRootProjectionV1(readBack),
  );
}

/** Triple insertion does not retain row order, so the rows are compared sorted. */
function sortedStoreTermsV1(quads: readonly Readonly<Quad>[]): string {
  return quads.map((quad) => quadToNQuad({ ...quad, graph: '' })).sort().join('\n');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
