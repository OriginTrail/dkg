import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { clearDischargedStorageAckCopies, storageAckCopiesDischargeUpdate } from '../src/storage-ack-copy-cleanup.js';
import { STORAGE_ACK_OPERATION_ID_PREFIX, storageAckOperationId } from '../src/storage-ack-ledger.js';

const META = 'did:dkg:context-graph:ack-cleanup/_shared_memory_meta';
const OTHER_META = 'did:dkg:context-graph:another/_shared_memory_meta';
const DATA = 'did:dkg:context-graph:ack-cleanup/data';
const DKG = 'http://dkg.io/ontology/';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const OTHER_UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/8';
const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

const subject = (id: string) => `urn:dkg:share:ack-cleanup:${id}`;
/**
 * One share-operation row set, in the shape the share and ACK writers persist. A version is an
 * integer literal unless it is given as a ready literal (a string that starts with a quote).
 */
function operation(id: string, shareId: string, ual: string, version: bigint | number | string | null, graph = META): Quad[] {
  const object = typeof version === 'string' ? version : `"${version}"^^<${INTEGER}>`;
  return [
    { graph, subject: subject(id), predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
    { graph, subject: subject(id), predicate: `${DKG}shareOperationId`, object: JSON.stringify(shareId) },
    { graph, subject: subject(id), predicate: `${DKG}kaUal`, object: ual },
    ...(version === null ? [] : [{ graph, subject: subject(id), predicate: `${DKG}assertionVersion`, object }]),
    { graph, subject: subject(id), predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(`sha256:${'ab'.repeat(32)}`) },
  ];
}
const ack = (id: string, version: bigint | number | string | null = 1, ual = UAL, graph = META) =>
  operation(id, `${STORAGE_ACK_OPERATION_ID_PREFIX}${id}`, ual, version, graph);
async function open(...rows: Quad[][]) {
  const store = new OxigraphStore();
  stores.push(store);
  for (const batch of rows) await store.insert(batch);
  return store;
}
const subjectsIn = async (store: OxigraphStore, graph = META) => {
  const result = await store.query(`SELECT DISTINCT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return result.type === 'bindings' ? result.bindings.map(row => row['s']!).sort() : [];
};
const clear = (store: Pick<OxigraphStore, 'update'>, cleaned: string[], kaUal = UAL) =>
  clearDischargedStorageAckCopies(store, { metaGraph: META, kaUal, cleanedOperations: cleaned.map(subject) });
/** The subjects a clear removed from the meta graph. */
async function removed(store: OxigraphStore, cleaned: string[], kaUal = UAL): Promise<string[]> {
  const before = await subjectsIn(store);
  await clear(store, cleaned, kaUal);
  const after = new Set(await subjectsIn(store));
  return before.filter(each => !after.has(each)).map(each => each.replace('urn:dkg:share:ack-cleanup:', ''));
}

describe('StorageACK copy removal', () => {
  it('finds a copy by the ledger prefix and id, and nothing that is not one', async () => {
    const generated = storageAckOperationId(UAL, 1, new Uint8Array(32).fill(3));
    expect(generated.startsWith(STORAGE_ACK_OPERATION_ID_PREFIX)).toBe(true);
    const store = await open(
      operation('cleaned', 'share-own', UAL, 1),
      operation('generated', generated, UAL, 1),
      operation('lookalike', `x${STORAGE_ACK_OPERATION_ID_PREFIX}1`, UAL, 1),
      operation('plain', 'share-plain', UAL, 1),
    );
    expect(await removed(store, ['cleaned'])).toEqual(['generated']);
  });

  it('removes copies at or below the newest cleaned version and none above it or of another asset', async () => {
    const store = await open(
      operation('cleaned-a', 'share-a', UAL, 1), operation('cleaned-b', 'share-b', UAL, 3),
      ack('v1', 1), ack('v3', 3), ack('v4', 4), ack('elsewhere', 1, OTHER_UAL),
    );
    expect(await removed(store, ['cleaned-a', 'cleaned-b'])).toEqual(['v1', 'v3']);
  });

  it('bounds at the lower cleaned operation when only that one is cleaned up', async () => {
    const store = await open(
      operation('cleaned-a', 'share-a', UAL, 1), operation('cleaned-b', 'share-b', UAL, 3), ack('v1', 1), ack('v3', 3));
    expect(await removed(store, ['cleaned-a'])).toEqual(['v1']);
  });

  it('removes every row of a removed copy and leaves every row of the others', async () => {
    const store = await open(operation('cleaned', 'share-own', UAL, 2), ack('gone', 1), ack('kept', 3));
    await clear(store, ['cleaned']);
    const count = async (id: string) => {
      const result = await store.query(`SELECT ?p WHERE { GRAPH <${META}> { <${subject(id)}> ?p ?o } }`);
      return result.type === 'bindings' ? result.bindings.length : -1;
    };
    expect(await count('gone')).toBe(0);
    expect(await count('kept')).toBe(5);
    expect(await count('cleaned')).toBe(5);
  });

  it('never removes the cleaned operations themselves, even when one looks like a copy', async () => {
    const store = await open(ack('cleaned'), ack('sibling'));
    expect(await removed(store, ['cleaned'])).toEqual(['sibling']);
  });

  it.each([
    ['a cleaned operation that is not in the graph', ['missing'], [ack('copy')]],
    ['a cleaned operation of another asset', ['cleaned'], [operation('cleaned', 'share-x', OTHER_UAL, 1), ack('copy')]],
    ['a cleaned operation whose version is not a number', ['cleaned'], [operation('cleaned', 'share-x', UAL, '"soon"'), ack('copy')]],
    ['a cleaned operation whose version is an untyped literal', ['cleaned'], [operation('cleaned', 'share-x', UAL, '"1"'), ack('copy')]],
    ['a cleaned operation without a version', ['cleaned'], [operation('cleaned', 'share-x', UAL, null), ack('copy')]],
    ['a cleaned operation without a share id', ['cleaned'], [operation('cleaned', 'share-x', UAL, 1).filter(quad => !quad.predicate.endsWith('shareOperationId')), ack('copy')]],
  ])('removes nothing for %s (no boundary: fail closed)', async (_label, cleaned, rows) => {
    const store = await open(...rows);
    const before = await subjectsIn(store);
    await clear(store, cleaned);
    expect(await subjectsIn(store)).toEqual(before);
  });

  it('ignores a cleaned version that is unusable and bounds at the usable ones', async () => {
    const store = await open(
      operation('bad', 'share-bad', UAL, '"soon"'), operation('good', 'share-good', UAL, 2), ack('a', 1), ack('b', 2), ack('c', 3));
    expect(await removed(store, ['bad', 'good'])).toEqual(['a', 'b']);
  });

  it('keeps a copy whose version is not an integer literal, or that has none', async () => {
    const store = await open(
      operation('cleaned', 'share-own', UAL, 5), ack('typed', 1), ack('plain', '"1"'), ack('word', '"soon"'), ack('none', null));
    expect(await removed(store, ['cleaned'])).toEqual(['typed']);
  });

  it('issues nothing for an empty set of cleaned operations', async () => {
    const store = await open(ack('copy'));
    const update = vi.spyOn(store, 'update');
    await clear(store, []);
    expect(update).not.toHaveBeenCalled();
    expect(await subjectsIn(store)).toEqual([subject('copy')]);
  });

  describe('with versions beyond a double\'s exact integers', () => {
    const TWO_53 = 9007199254740992n;
    const I64_MAX = 9223372036854775807n;
    const U64_MAX = 18446744073709551615n;
    it.each([
      // A double cannot tell 2^53 from 2^53 + 1: these are the pairs that a Number-based bound gets wrong.
      ['a copy just above a 2^53 boundary stays', TWO_53, [1n, TWO_53, TWO_53 + 1n, TWO_53 + 2n], [1n, TWO_53]],
      ['copies up to a 2^53 + 1 boundary go, the next stays', TWO_53 + 1n, [1n, TWO_53 - 1n, TWO_53, TWO_53 + 1n, TWO_53 + 2n], [1n, TWO_53 - 1n, TWO_53, TWO_53 + 1n]],
      ['the largest 64-bit signed version is exact', I64_MAX, [1n, I64_MAX - 1n, I64_MAX], [1n, I64_MAX - 1n, I64_MAX]],
      ['a boundary above 2^63 is exact', I64_MAX + 1n, [1n, I64_MAX, I64_MAX + 1n, I64_MAX + 2n], [1n, I64_MAX, I64_MAX + 1n]],
      ['the largest 64-bit unsigned version is exact', U64_MAX, [1n, U64_MAX - 1n, U64_MAX], [1n, U64_MAX - 1n, U64_MAX]],
      ['a version beyond 64 bits is exact', 2n ** 70n, [1n, 2n ** 70n - 1n, 2n ** 70n + 1n], [1n, 2n ** 70n - 1n]],
    ])('%s', async (_label, boundary, copies, expectedGone) => {
      const store = await open(operation('cleaned', 'share-own', UAL, boundary),
        ...copies.map((version, i) => ack(`c${i}`, version)));
      const gone = await removed(store, ['cleaned']);
      expect(gone).toEqual(copies.flatMap((version, i) => expectedGone.includes(version) ? [`c${i}`] : []));
    });

    it('keeps copies with huge versions above a small boundary', async () => {
      const store = await open(operation('cleaned', 'share-own', UAL, 5),
        ack('low', 5), ack('p53', TWO_53 + 1n), ack('i64', I64_MAX), ack('i64plus', I64_MAX + 1n), ack('u64', U64_MAX), ack('big', 2n ** 70n));
      expect(await removed(store, ['cleaned'])).toEqual(['low']);
    });

    it('orders equal-length versions digit by digit and different lengths by length', async () => {
      const store = await open(operation('cleaned', 'share-own', UAL, 120),
        ack('nine', 9), ack('ten', 10), ack('n99', 99), ack('n100', 100), ack('n119', 119), ack('n120', 120), ack('n121', 121), ack('n1000', 1000));
      expect(await removed(store, ['cleaned'])).toEqual(['n100', 'n119', 'n120', 'n99', 'nine', 'ten']);
    });
  });

  it('removes 130 and 700 copies in one update, each time leaving the others', async () => {
    for (const total of [130, 700]) {
      const ids = Array.from({ length: total }, (_, i) => `copy-${String(i).padStart(4, '0')}`);
      const store = await open(operation('cleaned', 'share-own', UAL, 1), ids.flatMap(id => ack(id)),
        ack('later', 2), ack('elsewhere', 1, OTHER_UAL), operation('plain', 'share-plain', UAL, 1));
      const update = vi.spyOn(store, 'update');
      expect(await removed(store, ['cleaned'])).toEqual(ids);
      expect(update).toHaveBeenCalledOnce();
      expect(await subjectsIn(store)).toEqual(['cleaned', 'elsewhere', 'later', 'plain'].map(subject));
    }
  });

  it('does not depend on how many unrelated operations the graph holds', async () => {
    // A sub-select with MAX took several seconds at this size on the embedded Oxigraph (it grows
    // quadratically: 23 s at 20,000), and a FILTER EXISTS far longer; the flat join takes milliseconds.
    const unrelated = Array.from({ length: 12000 }, (_, i) => i % 5 === 0
      ? operation(`other-${i}`, `share-other-${i}`, `did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/${1000 + (i % 300)}`, 1)
      : ack(`other-${i}`, 1, `did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/${1000 + (i % 300)}`));
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ack('copy-a'), ack('copy-b'), unrelated.flat());
    const before = await subjectsIn(store);
    // Only the update is timed, not the scans that check its effect.
    const started = Date.now();
    await clear(store, ['cleaned']);
    const elapsed = Date.now() - started;
    const after = new Set(await subjectsIn(store));
    expect(before.filter(each => !after.has(each))).toEqual([subject('copy-a'), subject('copy-b')]);
    expect(elapsed).toBeLessThan(2_000);
  }, 60_000);

  it('handles IRIs with unusual characters', async () => {
    const weird = ["urn:dkg:share:ack-cleanup:ack-é-中文-%E2%9C%93-'q'-a;b(c),d&e=f#g", 'urn:dkg:share:ack-cleanup:ack-%25-@-!-$-*-+-~'];
    const cleaned = 'urn:dkg:share:ack-cleanup:cl%20eaned#frag';
    const withSubject = (rows: Quad[], to: string) => rows.map(row => ({ ...row, subject: to }));
    const store = await open(
      withSubject(operation('x', 'share-own', UAL, 2), cleaned),
      withSubject(ack('a', 1), weird[0]!), withSubject(ack('b', 1), weird[1]!), ack('later', 3));
    const update = vi.spyOn(store, 'update');
    await clearDischargedStorageAckCopies(store, { metaGraph: META, kaUal: UAL, cleanedOperations: [cleaned] });
    expect(update).toHaveBeenCalledOnce();
    expect(await subjectsIn(store)).toEqual([cleaned, subject('later')].sort());
  });

  it('touches only the meta graph, whatever else holds rows of the same subjects', async () => {
    const rows = [operation('cleaned', 'share-own', UAL, 2), ack('copy', 1)];
    const store = await open(rows.flat(), rows.flatMap(each => each.map(row => ({ ...row, graph: OTHER_META }))),
      rows.flatMap(each => each.map(row => ({ ...row, graph: DATA }))));
    await clear(store, ['cleaned']);
    expect(await subjectsIn(store, META)).toEqual([subject('cleaned')]);
    expect(await subjectsIn(store, OTHER_META)).toEqual([subject('cleaned'), subject('copy')]);
    expect(await subjectsIn(store, DATA)).toEqual([subject('cleaned'), subject('copy')]);
  });

  it('sends one update that names the meta graph and is not an aggregate or a sub-query', async () => {
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ack('a'), ack('b'), ack('c'));
    const update = vi.spyOn(store, 'update');
    await clear(store, ['cleaned']);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![1]).toMatchObject({ touchedGraphs: [META], source: 'publisher.storageAckCopyCleanup' });
    // No sub-select, aggregate or EXISTS: those shapes are quadratic on Oxigraph (see the update's note).
    expect(update.mock.calls[0]![0]).not.toMatch(/\bSELECT\b|\bMAX\s*\(|\bEXISTS\b/i);
  });

  // Blazegraph's regular expressions are Java's, where `$` also matches before a trailing line
  // terminator: `"5\n"^^xsd:integer` would pass `^[1-9][0-9]*$` and be compared as a two-digit
  // version, deleting copies above the boundary. Oxigraph is strict, so the behavior cannot be
  // seen here; pin the generated text instead.
  it('validates a version without a $-anchored pattern, which Blazegraph lets match before a line terminator', async () => {
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ack('a'));
    const update = vi.spyOn(store, 'update');
    await clear(store, ['cleaned']);
    const text = update.mock.calls[0]![0] as string;
    const patterns = [...text.matchAll(/REGEX\(STR\([^)]*\),\s*"((?:[^"\\]|\\.)*)"\)/g)].map(match => match[1]!);
    expect(patterns.length, 'the version filters must use REGEX').toBeGreaterThanOrEqual(4);
    for (const pattern of patterns) expect(pattern, `pattern ${pattern}`).not.toContain('$');
  });

  it('does not use a cleaned version that ends in a line terminator as a boundary', async () => {
    const store = await open(
      operation('cleaned', 'share-own', UAL, `"5\\n"^^<${INTEGER}>`),
      ack('v3', 3), ack('v9', 9), ack('v12', 12),
    );
    expect(await removed(store, ['cleaned'])).toEqual([]);
  });

  it('refuses an IRI that cannot be written into an update, and issues nothing', async () => {
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ack('a'));
    const update = vi.spyOn(store, 'update');
    expect(() => storageAckCopiesDischargeUpdate({ metaGraph: META, kaUal: UAL, cleanedOperations: ['urn:x y'] })).toThrow();
    expect(() => storageAckCopiesDischargeUpdate({ metaGraph: META, kaUal: 'bad ual', cleanedOperations: [subject('cleaned')] })).toThrow();
    expect(() => storageAckCopiesDischargeUpdate({ metaGraph: 'bad graph', kaUal: UAL, cleanedOperations: [subject('cleaned')] })).toThrow();
    await expect(clearDischargedStorageAckCopies(store, {
      metaGraph: META, kaUal: UAL, cleanedOperations: [subject('cleaned'), '<bad>'],
    })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(await subjectsIn(store)).toEqual([subject('a'), subject('cleaned')]);
  });

  it('propagates a failed update, with every row still in place', async () => {
    const store = await open(operation('cleaned', 'share-own', UAL, 1), ack('a'), ack('b'));
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('store offline'));
    await expect(clear(store, ['cleaned'])).rejects.toThrow('store offline');
    expect(await subjectsIn(store)).toEqual([subject('a'), subject('b'), subject('cleaned')]);
  });

  it('rejects when the store cannot run an update', async () => {
    await expect(clearDischargedStorageAckCopies({} as Pick<OxigraphStore, 'update'>, {
      metaGraph: META, kaUal: UAL, cleanedOperations: [subject('cleaned')],
    })).rejects.toThrow('cannot run an update');
  });
});
