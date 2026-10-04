// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

export async function readExactGraph(store: TripleStore, graph: string): Promise<Quad[]> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readGraph' },
  );
  // The persistent Oxigraph worker reports an empty CONSTRUCT as the generic
  // zero-row bindings shape, while the in-process adapter reports `quads: []`.
  // Accept only that exact empty compatibility shape; non-empty bindings stay
  // fail-closed because converting them would lose RDF term identity.
  if (result.type === 'bindings' && result.bindings.length === 0) return [];
  if (result.type !== 'quads') {
    throw new Error(`Unexpected exact-graph query result for ${graph}: ${result.type}`);
  }
  return result.quads.map((quad) => ({ ...quad, graph: '' }));
}

export function parseInteger(value: string | undefined): bigint | null {
  if (!value) return null;
  const match = /^"?([0-9]+)"?(?:\^\^<[^>]+>)?$/.exec(value);
  if (!match?.[1]) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

export function parseSafeCount(value: string | undefined): number | null {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

export function literalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/.exec(value);
  return match?.[1] ?? value;
}

export function normalizeHex32(value: string): string {
  const raw = literalValue(value)?.trim().replace(/^0x/i, '').toLowerCase();
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) throw new Error('Expected a 32-byte hexadecimal value');
  return `0x${raw}`;
}

export function optionalHex32(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeHex32(value);
  } catch {
    return undefined;
  }
}
