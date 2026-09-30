import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type QueryResult, type Quad } from '@origintrail-official/dkg-storage';
import {
  clearDischargedStorageAckCopies,
  noDischargedStorageAckCopies,
  planDischargedStorageAckCopies,
  storageAckCleanedVersionsQuery,
  storageAckCopiesDeleteUpdate,
  storageAckDischargedCopiesPageQuery,
} from '../src/storage-ack-copy-cleanup.js';
import { STORAGE_ACK_OPERATION_ID_PREFIX, storageAckOperationId } from '../src/storage-ack-ledger.js';

const META = 'did:dkg:context-graph:ack-cleanup/_shared_memory_meta';
const DKG = 'http://dkg.io/ontology/';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const OTHER_UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/8';
const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

const subject = (id: string) => `urn:dkg:share:ack-cleanup:${id}`;
/** One share-operation row set, in the shape the share and ACK writers persist. */
function operation(id: string, shareId: string, ual: string, version: string | number): Quad[] {
  const object = typeof version === 'number' ? `"${version}"^^<${INTEGER}>` : version;
  return [
    { graph: META, subject: subject(id), predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
    { graph: META, subject: subject(id), predicate: `${DKG}shareOperationId`, object: JSON.stringify(shareId) },
    { graph: META, subject: subject(id), predicate: `${DKG}kaUal`, object: ual },
    { graph: META, subject: subject(id), predicate: `${DKG}assertionVersion`, object },
  ];
}
const ack = (id: string, ual = UAL, version: string | number = 1) =>
  operation(id, `${STORAGE_ACK_OPERATION_ID_PREFIX}${id}`, ual, version);
async function open(...rows: Quad[][]) {
  const store = new OxigraphStore();
  stores.push(store);
  await store.insert(rows.flat());
  return store;
}
const plan = (store: Pick<OxigraphStore, 'query'>, cleaned: string[], limits?: { pageSize?: number; maxPages?: number; deadlineAt?: number }) =>
  planDischargedStorageAckCopies(store, { metaGraph: META, kaUal: UAL, cleanedOperations: cleaned }, limits);
const bindings = (rows: Array<Record<string, string>>): QueryResult => ({ type: 'bindings', bindings: rows });

describe('StorageACK copy plan', () => {
  it('finds a copy by the ledger prefix and id, and nothing that is not one', async () => {
    const generated = storageAckOperationId(UAL, 1, new Uint8Array(32).fill(3));
    expect(generated.startsWith(STORAGE_ACK_OPERATION_ID_PREFIX)).toBe(true);
    const store = await open(
      operation('cleaned', 'share-own', UAL, 1),
      operation('generated', generated, UAL, 1),
      operation('lookalike', `x${STORAGE_ACK_OPERATION_ID_PREFIX}1`, UAL, 1),
      operation('plain', 'share-plain', UAL, 1),
    );
    expect(await plan(store, [subject('cleaned')])).toEqual({
      metaGraph: META, operations: [subject('generated')], truncated: false,
    });
  });

  it('plans copies at or below the newest cleaned version and none above it or of another asset', async () => {
    const store = await open(
      operation('cleaned-a', 'share-a', UAL, 1), operation('cleaned-b', 'share-b', UAL, 3),
      ack('v1', UAL, 1), ack('v3', UAL, 3), ack('v4', UAL, 4), ack('elsewhere', OTHER_UAL, 1),
    );
    expect([...(await plan(store, [subject('cleaned-a'), subject('cleaned-b')])).operations].sort())
      .toEqual([subject('v1'), subject('v3')]);
    // Only the lower cleaned operation: the boundary moves down with it.
    expect((await plan(store, [subject('cleaned-a')])).operations).toEqual([subject('v1')]);
  });

  it('does not plan the cleaned operations themselves, even when one looks like a copy', async () => {
    const store = await open(ack('cleaned'), ack('sibling'));
    expect((await plan(store, [subject('cleaned')])).operations).toEqual([subject('sibling')]);
  });

  it.each([
    ['no cleaned operation', [] as string[], []],
    ['a cleaned operation with no rows', [subject('missing')], [ack('copy')]],
    ['a cleaned operation of another asset', [subject('cleaned')], [operation('cleaned', 'share-x', OTHER_UAL, 1), ack('copy')]],
    ['a cleaned operation whose version is not a number', [subject('cleaned')], [operation('cleaned', 'share-x', UAL, '"soon"'), ack('copy')]],
  ])('plans nothing for %s', async (_label, cleaned, rows) => {
    const store = await open(...rows);
    const query = vi.spyOn(store, 'query');
    expect(await plan(store, cleaned)).toEqual(noDischargedStorageAckCopies(META));
    // Without a cleaned operation nothing is even asked.
    if (cleaned.length === 0) expect(query).not.toHaveBeenCalled();
  });

  it('reads every copy through keyset pages, whatever the page size', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ...ids.map(id => ack(id)));
    const query = vi.spyOn(store, 'query');
    const planned = await plan(store, [subject('cleaned')], { pageSize: 2 });
    expect(planned.operations).toEqual(ids.map(subject));
    expect(planned.truncated).toBe(false);
    // The boundary and then pages of 2, 2, 2, 1.
    expect(query).toHaveBeenCalledTimes(1 + 4);
    // A short last page ends it; a full last page is followed by one empty page.
    query.mockClear();
    expect((await plan(store, [subject('cleaned')], { pageSize: 7 })).operations).toHaveLength(7);
    expect(query).toHaveBeenCalledTimes(1 + 2);
  });

  it('marks a plan truncated at the page limit and keeps what it has', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ...ids.map(id => ack(id)));
    expect(await plan(store, [subject('cleaned')], { pageSize: 2, maxPages: 2 })).toEqual({
      metaGraph: META, operations: ['a', 'b', 'c', 'd'].map(subject), truncated: true,
    });
  });

  it('stops reading pages once the time budget is spent and keeps what it has', async () => {
    let clock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const pages = [['a', 'b'], ['c', 'd'], ['e']].map(page => page.map(id => ({ operation: subject(id) })));
    let served = 0;
    const query = vi.fn(async (sparql: string) => {
      if (!sparql.includes('ORDER BY')) return bindings([{ version: `"1"^^<${INTEGER}>` }]);
      clock += 400; // every page costs 400 ms of the budget
      return bindings(pages[served++] ?? []);
    });
    // The deadline falls between the second and third page: the third is never asked for.
    const planned = await plan({ query }, [subject('cleaned')], { pageSize: 2, deadlineAt: 1_500 });
    expect(planned).toEqual({ metaGraph: META, operations: ['a', 'b', 'c', 'd'].map(subject), truncated: true });
    expect(query).toHaveBeenCalledTimes(1 + 2);
    // A deadline that is already past reads no page at all.
    query.mockClear();
    served = 0;
    expect(await plan({ query }, [subject('cleaned')], { pageSize: 2, deadlineAt: 0 }))
      .toEqual({ metaGraph: META, operations: [], truncated: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stops when a store keeps answering the same full page', async () => {
    const page = [{ operation: subject('a') }, { operation: subject('b') }];
    const query = vi.fn(async (sparql: string) => sparql.includes('ORDER BY') ? bindings(page) : bindings([{ version: `"1"^^<${INTEGER}>` }]));
    const planned = await plan({ query }, [subject('cleaned')], { pageSize: 2, maxPages: 50 });
    expect(planned).toEqual({ metaGraph: META, operations: [subject('a'), subject('b')], truncated: true });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('rejects an answer that is not a set of bindings, at either step', async () => {
    const boolean = async (): Promise<QueryResult> => ({ type: 'boolean', value: true });
    await expect(plan({ query: boolean }, [subject('cleaned')])).rejects.toThrow('did not return bindings');
    const pages = async (sparql: string): Promise<QueryResult> =>
      sparql.includes('ORDER BY') ? boolean() : bindings([{ version: `"1"^^<${INTEGER}>` }]);
    await expect(plan({ query: pages }, [subject('cleaned')])).rejects.toThrow('did not return bindings');
  });

  it('refuses an IRI that cannot be written into a query', async () => {
    expect(() => storageAckCleanedVersionsQuery(META, UAL, ['urn:x y'])).toThrow();
    expect(() => storageAckDischargedCopiesPageQuery({ metaGraph: META, kaUal: 'bad ual', maxVersion: 1, after: '', limit: 2 })).toThrow();
    expect(() => storageAckCopiesDeleteUpdate(META, ['<bad>'])).toThrow();
  });
});

describe('StorageACK copy removal', () => {
  const rows = async (store: OxigraphStore, id: string) => {
    const result = await store.query(`SELECT ?p WHERE { GRAPH <${META}> { <${subject(id)}> ?p ?o } }`);
    return result.type === 'bindings' ? result.bindings.length : 0;
  };

  it('removes every row of every planned copy in one update and leaves other subjects alone', async () => {
    const store = await open(ack('a'), ack('b'), ack('c'), operation('kept', 'share-kept', UAL, 1));
    const update = vi.spyOn(store, 'update');
    await clearDischargedStorageAckCopies(store, {
      metaGraph: META, operations: [subject('a'), subject('b'), subject('c')], truncated: false,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![1]).toMatchObject({ touchedGraphs: [META] });
    for (const id of ['a', 'b', 'c']) expect(await rows(store, id)).toBe(0);
    expect(await rows(store, 'kept')).toBe(4);
  });

  it('does nothing for an empty plan', async () => {
    const store = await open(ack('a'));
    const update = vi.spyOn(store, 'update');
    await clearDischargedStorageAckCopies(store, noDischargedStorageAckCopies(META));
    expect(update).not.toHaveBeenCalled();
    expect(await rows(store, 'a')).toBe(4);
  });

  it('propagates a failed update, with every planned copy still in place', async () => {
    const store = await open(ack('a'), ack('b'));
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('store offline'));
    await expect(clearDischargedStorageAckCopies(store, {
      metaGraph: META, operations: [subject('a'), subject('b')], truncated: false,
    })).rejects.toThrow('store offline');
    expect(await rows(store, 'a')).toBe(4);
    expect(await rows(store, 'b')).toBe(4);
  });
});
