// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';

export function readControlAnchor(
  quads: readonly Quad[],
  predicate: string,
  label: string,
): string {
  const values = [...new Set(
    quads.filter((quad) => quad.predicate === predicate).map((quad) => quad.object),
  )];
  if (values.length !== 1) {
    throw new Error(`Locally trusted KA controls require exactly one ${label}`);
  }
  return values[0]!;
}

export function parseControlVersion(raw: string): bigint {
  const lexical = raw.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  if (!/^\d+$/.test(lexical)) throw new Error(`Invalid trusted-control assertionVersion: ${raw}`);
  return BigInt(lexical);
}

export function normalizeControlRoot(raw: string): string {
  const lexical = raw.match(/^"([^"]*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  const root = lexical.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(root)) throw new Error(`Invalid trusted-control merkleRoot: ${raw}`);
  return root;
}
