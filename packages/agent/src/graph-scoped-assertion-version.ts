// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore, QueryOptions } from '@origintrail-official/dkg-storage';
const ASSERTION_VERSION = 'http://dkg.io/ontology/assertionVersion';
/** Shared assertion ordering gate; callers hold the per-asset materialization lock. */
export async function readCurrentAssertionVersion(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  options?: QueryOptions,
): Promise<bigint | undefined> {
  const result = await store.query(`
    SELECT ?version WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        <${assertSafeIri(ual)}> <${ASSERTION_VERSION}> ?version .
      }
    }
  `, options);
  if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;

  let latest: bigint | undefined;
  for (const row of result.bindings) {
    const raw = row.version;
    const lexical = raw?.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
    if (lexical === undefined || !/^\d+$/.test(lexical)) {
      throw new Error(`Invalid stored assertionVersion metadata for ${ual}: ${raw ?? '<missing>'}`);
    }
    const version = BigInt(lexical);
    if (latest === undefined || version > latest) latest = version;
  }
  return latest;
}

