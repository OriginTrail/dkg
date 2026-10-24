// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore, QueryOptions } from '@origintrail-official/dkg-storage';

const ASSERTION_VERSION = 'http://dkg.io/ontology/assertionVersion';

/** Read under the caller-owned lock after its graph/UAL validation. Decode lazily so
 * stale-write callers can retain their early-return policy without inspecting later rows. */
export async function readStoredAssertionVersions(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  options?: QueryOptions,
): Promise<Iterable<bigint>> {
  const result = await store.query(`
    SELECT ?version WHERE {
      GRAPH <${metaGraph}> {
        <${ual}> <${ASSERTION_VERSION}> ?version .
      }
    }
  `, options);
  if (result.type !== 'bindings') return [];
  return decodeAssertionVersions(result.bindings, ual);
}

function* decodeAssertionVersions(rows: readonly Record<string, string>[], ual: string): Iterable<bigint> {
  for (const row of rows) {
    const raw = row.version;
    const lexical = raw?.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
    if (lexical === undefined || !/^\d+$/.test(lexical)) {
      throw new Error(`Invalid stored assertionVersion metadata for ${ual}: ${raw ?? '<missing>'}`);
    }
    yield BigInt(lexical);
  }
}

/** Return the greatest stored assertion version; callers own materialization locking and repair policy. */
export async function readCurrentAssertionVersion(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  options?: QueryOptions,
): Promise<bigint | undefined> {
  assertSafeIri(metaGraph);
  assertSafeIri(ual);
  let latest: bigint | undefined;
  for (const version of await readStoredAssertionVersions(store, metaGraph, ual, options)) {
    if (latest === undefined || version > latest) latest = version;
  }
  return latest;
}
