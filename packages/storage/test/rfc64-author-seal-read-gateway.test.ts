import { describe, expect, it } from 'vitest';

import {
  compileRfc64AuthorSealReadOperationV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';

import {
  OxigraphStore,
  OxigraphWorkerStore,
  SyncAuthorSealStoreV1,
  type TripleStore,
} from '../src/index.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const RESERVED_KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const COORDINATE = Object.freeze({
  contextGraphId: 'a/b',
  subGraphName: null,
  authorAddress: AUTHOR,
  assertionCoordinate: 'name λ',
}) as CanonicalGraphScopedAuthorSealCoordinateV1;
const PAYLOAD = Object.freeze({
  assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
  assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
  assertionMerkleRoot: `0x${'aa'.repeat(32)}`,
  assertionVersion: '2',
  authorAddress: AUTHOR,
  authorAttestationR: `0x${'11'.repeat(32)}`,
  authorAttestationVS: `0x${'22'.repeat(32)}`,
  authorSchemeVersion: '1',
  contentScopeVersion: '2',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
  privateMerkleRoot: null,
  privateTripleCount: '0',
  publicTripleCount: '12977',
  reservedKaId: RESERVED_KA_ID,
}) as CanonicalGraphScopedAuthorSealV1;
const PRIVATE_PAYLOAD = Object.freeze({
  ...PAYLOAD,
  privateMerkleRoot: `0x${'bb'.repeat(32)}`,
  privateTripleCount: '41',
  publicTripleCount: '12',
}) as CanonicalGraphScopedAuthorSealV1;

describe('SyncAuthorSealStoreV1', () => {
  it('round-trips the exact seal through embedded Oxigraph', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([...projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE)]);
      const result = await new SyncAuthorSealStoreV1(store).read(
        { coordinate: COORDINATE },
        { timeoutMs: 1_000 },
      );
      expect(result.kind).toBe('seal');
      if (result.kind === 'seal') expect(result.decoded.payload).toEqual(PAYLOAD);
    } finally {
      await store.close();
    }
  });

  it('round-trips the complete 15-row private seal', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...projectCanonicalGraphScopedAuthorSealRowsV1(PRIVATE_PAYLOAD, COORDINATE),
      ]);
      const result = await new SyncAuthorSealStoreV1(store).read(
        { coordinate: COORDINATE },
        { timeoutMs: 1_000 },
      );
      expect(result.kind).toBe('seal');
      if (result.kind === 'seal') expect(result.decoded.payload).toEqual(PRIVATE_PAYLOAD);
    } finally {
      await store.close();
    }
  });

  it('round-trips the same seal through the real worker adapter', async () => {
    const store = new OxigraphWorkerStore();
    try {
      await store.insert([...projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE)]);
      const result = await new SyncAuthorSealStoreV1(store).read(
        { coordinate: COORDINATE },
        { timeoutMs: 5_000 },
      );
      expect(result.kind).toBe('seal');
      if (result.kind === 'seal') expect(result.decoded.payload).toEqual(PAYLOAD);
    } finally {
      await store.close();
    }
  });

  it('finds certification through decorators and rejects uncertified generic stores', async () => {
    const store = new OxigraphStore();
    try {
      const decorated = {
        innerStore: store,
        query: store.query.bind(store),
      } as unknown as TripleStore;
      await expect(new SyncAuthorSealStoreV1(decorated).read(
        { coordinate: COORDINATE },
        { timeoutMs: 1_000 },
      )).resolves.toEqual({ kind: 'absent' });
      expect(() => new SyncAuthorSealStoreV1({
        query: store.query.bind(store),
      } as unknown as TripleStore)).toThrow(/no certified RFC-64 author-seal read capability/u);
    } finally {
      await store.close();
    }
  });

  it('rejects a conflicting duplicate predicate instead of hiding it behind LIMIT', async () => {
    const store = new OxigraphStore();
    try {
      const rows = [...projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE)];
      await store.insert([
        ...rows,
        { ...rows[0]!, object: `"${'bb'.repeat(32)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>` },
      ]);
      await expect(new SyncAuthorSealStoreV1(store).read(
        { coordinate: COORDINATE },
        { timeoutMs: 1_000 },
      )).rejects.toThrow(/duplicate author-seal predicate/u);
      expect(compileRfc64AuthorSealReadOperationV1({ coordinate: COORDINATE }).rowCeiling)
        .toBe(16);
    } finally {
      await store.close();
    }
  });

  it('covers dispatch and strict decoding with one deadline', async () => {
    const inner = new OxigraphStore();
    const capability = {
      rfc64AuthorSealReadV1: async (...args: Parameters<NonNullable<TripleStore['rfc64AuthorSealReadV1']>>) => {
        const rows = await inner.rfc64AuthorSealReadV1!(...args);
        const end = performance.now() + 15;
        while (performance.now() < end) { /* model synchronous post-query normalization */ }
        return rows;
      },
    } as unknown as TripleStore;
    try {
      await inner.insert([...projectCanonicalGraphScopedAuthorSealRowsV1(PAYLOAD, COORDINATE)]);
      await expect(new SyncAuthorSealStoreV1(capability).read(
        { coordinate: COORDINATE },
        { timeoutMs: 5 },
      )).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      await inner.close();
    }
  });

  it('propagates caller cancellation through the certified capability', async () => {
    const controller = new AbortController();
    const capability = {
      rfc64AuthorSealReadV1: async (
        _operation: Parameters<NonNullable<TripleStore['rfc64AuthorSealReadV1']>>[0],
        options: Parameters<NonNullable<TripleStore['rfc64AuthorSealReadV1']>>[1],
      ) => {
        controller.abort(new DOMException('caller stopped the read', 'AbortError'));
        options?.signal?.throwIfAborted();
        return [];
      },
    } as unknown as TripleStore;

    await expect(new SyncAuthorSealStoreV1(capability).read(
      { coordinate: COORDINATE },
      { timeoutMs: 1_000, signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
  });
});
