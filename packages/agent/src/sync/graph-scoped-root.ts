// SPDX-License-Identifier: Apache-2.0
import { rdfLiteralBody } from '@origintrail-official/dkg-rdf-utils';

/** Canonical bytes32 RDF root decoding shared by verification and authentication. */
export function normalizeGraphScopedHex32(raw: string, field: string): string {
  const hex = (rdfLiteralBody(raw) ?? raw).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${field} must be exactly 32 bytes of hexadecimal data`);
  return hex;
}

