/**
 * What a stored SWM head newer than a peer's descriptor proves, against a real
 * OxigraphStore. Keeping that head is one decision; holding what the peer
 * served is another, and only the newer head's own committed content in the
 * store proves it (#3296 review). Metadata alone, other bytes under the head,
 * or a head no reader resolves prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import {
  newerStoredHeadIsMaterialized,
  storedVersionOutranksDescriptor,
} from '../src/sync/requester/swm-stored-head-proof.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

const CG = 'stored-head-proof';
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/9';
const fx = swmFixtures(CG);
const v1 = fx.share({ version: 1, operationId: 'op-v1', marker: 'version-one', ual: UAL });
const v2 = fx.share({ version: 2, operationId: 'op-v2', marker: 'version-two', ual: UAL });

function descriptorFor(fixture: typeof v1) {
  const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: fixture.meta });
  return descriptor!;
}

function inGraph(quads: readonly Quad[], graph: string): Quad[] {
  return quads.map((quad) => ({ ...quad, graph }));
}

async function storeWith(...batches: Quad[][]): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  for (const batch of batches) await store.insert(batch);
  return store;
}

/** v2's head with its assertionVersion row replaced by `objects`. */
function v2HeadVersionedAs(...objects: string[]): Quad[] {
  return [
    ...v2.meta.filter((quad) => !(quad.subject === v2.headSubject && quad.predicate === `${DKG}assertionVersion`)),
    ...objects.map((object) => ({
      subject: v2.headSubject, predicate: `${DKG}assertionVersion`, object, graph: fx.metaGraph,
    })),
  ];
}

describe('storedVersionOutranksDescriptor: whether catch-up keeps the stored head', () => {
  it.each([
    ['2', '1', true],
    ['1', '1', false],
    ['1', '2', false],
    // An ordering it cannot read is kept, never overwritten.
    ['not-a-version', '1', true],
  ])('stored %s against descriptor %s: %s', (stored, descriptorVersion, keep) => {
    expect(storedVersionOutranksDescriptor(stored, descriptorVersion)).toBe(keep);
  });
});

describe('newerStoredHeadIsMaterialized: whether the kept head proves the asset held', () => {
  it('holds when the newer head and its own content are both stored', async () => {
    const store = await storeWith([...v2.meta], inGraph(v2.payload, v2.assertionGraph));

    expect(await newerStoredHeadIsMaterialized(store, CG, descriptorFor(v1))).toBe(true);
  });

  it.each([
    ['only the newer head metadata', async () => storeWith([...v2.meta])],
    ['the older version\'s bytes under the newer head', async () => storeWith(
      [...v2.meta], inGraph(v1.payload, v2.assertionGraph),
    )],
    ['part of the newer content', async () => storeWith(
      [...v2.meta], inGraph(v2.payload.slice(1), v2.assertionGraph),
    )],
    ['a head with two version rows', async () => storeWith(
      v2HeadVersionedAs(`"2"^^<${XSD_INTEGER}>`, `"3"^^<${XSD_INTEGER}>`), inGraph(v2.payload, v2.assertionGraph),
    )],
    ['a head whose version does not parse', async () => storeWith(
      v2HeadVersionedAs('"not-a-version"'), inGraph(v2.payload, v2.assertionGraph),
    )],
    ['no head at all', async () => storeWith(inGraph(v2.payload, v2.assertionGraph))],
  ])('does not hold with %s', async (_state, seed) => {
    const store = await seed();

    expect(await newerStoredHeadIsMaterialized(store, CG, descriptorFor(v1))).toBe(false);
  });

  it('does not hold a head that is not newer than the descriptor', async () => {
    const store = await storeWith([...v2.meta], inGraph(v2.payload, v2.assertionGraph));

    expect(await newerStoredHeadIsMaterialized(store, CG, descriptorFor(v2))).toBe(false);
  });

  it('lets a failed store read propagate instead of answering', async () => {
    const backing = await storeWith([...v2.meta], inGraph(v2.payload, v2.assertionGraph));
    const failure = new Error('store unavailable');
    const store = new Proxy(backing, {
      get: (target, key, receiver) => (key === 'query'
        ? async () => { throw failure; }
        : Reflect.get(target, key, receiver)),
    }) as TripleStore;

    await expect(newerStoredHeadIsMaterialized(store, CG, descriptorFor(v1))).rejects.toBe(failure);
  });

  it('is the store adapter\'s proof, on the materializer catch-up uses', async () => {
    const store = await storeWith([...v2.meta]);
    const materializer = createSharedMemorySnapshotMaterializer({
      store, writeLocks: new Map<string, Promise<void>>(), invalidateListContextGraphsCache: () => {},
    });

    expect(await materializer.isNewerStoredHeadMaterialized(CG, descriptorFor(v1))).toBe(false);
    await store.insert(inGraph(v2.payload, v2.assertionGraph));
    expect(await materializer.isNewerStoredHeadMaterialized(CG, descriptorFor(v1))).toBe(true);
  });
});
