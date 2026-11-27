import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { readCurrentAssertionVersion } from '../src/materialization-assertion-version.js';
import { shouldApplyMaterialization } from '../src/metadata.js';

const graph = 'urn:meta', ual = 'urn:asset';
const incoming = { blockNumber: 10, txIndex: 2 };
function fixture(values: Array<string | undefined>) {
  const query = vi.fn().mockResolvedValue({ type: 'bindings', bindings: values.map(version => ({ version })) });
  return { query, store: { query } as unknown as TripleStore };
}

describe('shared materialization assertion-version reads', () => {
  it.each(['2', '"2"', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>', '"2"@en'])(
    'accepts the existing binding representation %s', async value => {
      const { store } = fixture([value]);
      expect(await readCurrentAssertionVersion(store, graph, ual)).toBe(2n);
      expect(await shouldApplyMaterialization(store, graph, ual, incoming, 1n)).toBe(false);
    },
  );

  it('finds the greatest version without losing bigint precision and forwards options', async () => {
    const { store, query } = fixture(['2', '9007199254740993', '1']);
    const options = { signal: new AbortController().signal };
    expect(await readCurrentAssertionVersion(store, graph, ual, options)).toBe(9007199254740993n);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('assertionVersion'), options);
  });

  it.each([[], undefined])('treats absent bindings as no current assertion: %j', async values => {
    const { store, query } = fixture(values ?? []);
    if (values === undefined) query.mockResolvedValue({ type: 'boolean', value: false });
    expect(await readCurrentAssertionVersion(store, graph, ual)).toBeUndefined();
  });

  it.each([undefined, '-1', '1.5', '"bad"'])('rejects malformed metadata in both callers: %j', async value => {
    const { store } = fixture([value]);
    await expect(readCurrentAssertionVersion(store, graph, ual)).rejects.toThrow('Invalid stored assertionVersion metadata');
    await expect(shouldApplyMaterialization(store, graph, ual, incoming, 2n)).rejects.toThrow('Invalid stored assertionVersion metadata');
  });

  it('preserves stale-write early return while greatest-version reads validate every row', async () => {
    const { store, query } = fixture(['3', '"bad"']);
    expect(await shouldApplyMaterialization(store, graph, ual, incoming, 2n)).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(readCurrentAssertionVersion(store, graph, ual)).rejects.toThrow('Invalid stored assertionVersion metadata');
  });

  it.each([
    [{ blockNumber: 10, txIndex: 1 }, false],
    [{ blockNumber: 10, txIndex: 2 }, true],
    [{ blockNumber: 11, txIndex: 0 }, true],
  ] as const)('retains block ordering and same-version reapply after equal assertion version', async (version, allowed) => {
    const { store, query } = fixture(['2']);
    query.mockResolvedValueOnce({ type: 'bindings', bindings: [{ version: '2' }] })
      .mockResolvedValueOnce({ type: 'bindings', bindings: [{ v: '"10:2"' }] });
    expect(await shouldApplyMaterialization(store, graph, ual, version, 2n)).toBe(allowed);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves each caller validation boundary before store access', async () => {
    const { store, query } = fixture(['2']);
    await expect(readCurrentAssertionVersion(store, 'urn:bad>graph', ual)).rejects.toThrow('Unsafe or empty IRI');
    await expect(shouldApplyMaterialization(store, 'urn:bad>graph', ual, incoming, 2n)).rejects.toThrow('Unsafe graph IRI');
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates dependency errors unchanged', async () => {
    const { store, query } = fixture([]), failure = new Error('read unavailable');
    query.mockRejectedValue(failure);
    await expect(readCurrentAssertionVersion(store, graph, ual)).rejects.toBe(failure);
    await expect(shouldApplyMaterialization(store, graph, ual, incoming, 2n)).rejects.toBe(failure);
  });
});
