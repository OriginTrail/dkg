// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { WORKSPACE_RECIPIENT_DEPENDENCIES, WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES, resolveWorkspaceAgentRecipientKeys } from '@origintrail-official/dkg-publisher';

import { RECIPIENT_KEY_ROUTE_PREDICATES } from '../src/internal/recipient-key-route-fence.js';
import { PROFILE_GRAPH, signedKeyFixture } from './_helpers/signed-private-keys.js';

// The fence decides from RECIPIENT_KEY_ROUTE_PREDICATES which writes can change a
// private-roster resolution, so a predicate the resolver starts to read that is missing
// from it would leave the writes to that fact unfenced. The resolver owns the queries;
// this test runs it over every kind of record it reads and compares what its queries name.
const ONTOLOGY_NAMESPACE = DKG_ONTOLOGY.DKG_PEER_ID.slice(0, DKG_ONTOLOGY.DKG_PEER_ID.lastIndexOf('#') + 1);
const NAMED_ONTOLOGY_IRI = new RegExp(`<(${ONTOLOGY_NAMESPACE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^>\\s]+)>`, 'g');

function recording(inner: OxigraphStore, queries: string[]): TripleStore {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'query') {
        return (sparql: string, options?: unknown) => {
          queries.push(sparql);
          return (target.query as (q: string, o?: unknown) => Promise<unknown>)(sparql, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const namedBy = (queries: readonly string[]): Set<string> => new Set(
  queries.flatMap((sparql) => [...sparql.matchAll(NAMED_ONTOLOGY_IRI)].map((match) => match[1]!)),
);
const missingFrom = (named: ReadonlySet<string>, list: ReadonlySet<string>): string[] => [...named].filter((p) => !list.has(p));

describe('recipient key/route fence dependencies (GH#3067)', () => {
  it('lists every predicate the key resolver names, so no write it reads goes unfenced', async () => {
    const queries: string[] = [];
    const wallet = ethers.Wallet.createRandom();
    const fixture = signedKeyFixture(wallet, '12D3KooWPeer');

    // A live key with its proof and route, then the same key revoked: together they take
    // every query of the resolver, including the revocation and the wrong-algorithm probe.
    for (const revoked of [false, true]) {
      const store = new OxigraphStore();
      await store.insert([
        ...fixture.quads,
        ...(revoked
          ? [{ subject: fixture.recipientKeyId, predicate: DKG_ONTOLOGY.DKG_REVOKED_AT, object: '"2026-01-01T00:00:00Z"', graph: PROFILE_GRAPH }]
          : []),
      ]);
      await resolveWorkspaceAgentRecipientKeys(recording(store, queries), wallet.address).catch(() => undefined);
      await store.close();
    }

    const named = namedBy(queries);
    // Not vacuous: the records above make the resolver name each of these.
    for (const predicate of [
      DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
      DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
      DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
      DKG_ONTOLOGY.DKG_PEER_ID,
      DKG_ONTOLOGY.DKG_REVOKED_AT,
      DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
    ]) {
      expect(named.has(predicate), predicate).toBe(true);
    }
    expect(missingFrom(named, RECIPIENT_KEY_ROUTE_PREDICATES)).toEqual([]);
  });

  it('derives the fence and scan predicates from the immutable publisher contract', () => {
    expect([...RECIPIENT_KEY_ROUTE_PREDICATES]).toEqual(WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES);
    expect(WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES).toEqual(Object.values(WORKSPACE_RECIPIENT_DEPENDENCIES.keyRoute));
    expect(Object.isFrozen(WORKSPACE_RECIPIENT_DEPENDENCIES.keyRoute)).toBe(true);
    expect(Object.isFrozen(WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES)).toBe(true);
  });
});
