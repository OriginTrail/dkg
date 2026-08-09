import { describe, expect, it } from 'vitest';
import { contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { pruneTerminalJoinRequestRecords } from '../src/join-request-retention.js';

const CG = 'moderation-retention';
const META = contextGraphMetaGraphUri(CG);
const STATUS = 'https://dkg.network/ontology#requestStatus';
const TIMESTAMP = 'https://dkg.network/ontology#requestTimestamp';
const DECISION_TIMESTAMP = 'https://dkg.network/ontology#decisionTimestamp';

function requestQuads(
  id: number,
  status: 'pending' | 'approved' | 'rejected',
  options: { requestTimestamp?: number | null; decisionTimestamp?: number } = {},
): Quad[] {
  const subject = `did:dkg:join-request:${CG}:0x${id.toString(16).padStart(40, '0')}`;
  const quads: Quad[] = [
    { graph: META, subject, predicate: STATUS, object: `"${status}"` },
    { graph: META, subject, predicate: 'https://schema.org/name', object: `"request-${id}"` },
  ];
  const requestTimestamp = options.requestTimestamp === undefined ? id : options.requestTimestamp;
  if (requestTimestamp !== null) {
    quads.push({ graph: META, subject, predicate: TIMESTAMP, object: `"${requestTimestamp}"` });
  }
  if (options.decisionTimestamp !== undefined) {
    quads.push({
      graph: META,
      subject,
      predicate: DECISION_TIMESTAMP,
      object: `"${options.decisionTimestamp}"`,
    });
  }
  return quads;
}

describe('terminal join-request retention', () => {
  it('keeps the newest bounded terminal tail without deleting pending requests', async () => {
    const store = new OxigraphStore();
    await store.insert([
      ...requestQuads(1, 'approved'),
      ...requestQuads(2, 'rejected'),
      ...requestQuads(3, 'approved'),
      ...requestQuads(4, 'rejected'),
      ...requestQuads(5, 'approved'),
      ...requestQuads(6, 'pending'),
    ]);

    await expect(pruneTerminalJoinRequestRecords(store, CG, 2)).resolves.toBeUndefined();

    const result = await store.query(`
      SELECT ?request ?status WHERE {
        GRAPH <${META}> { ?request <${STATUS}> ?status }
      }
      ORDER BY ?request
    `);
    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') return;
    expect(result.bindings.map((row) => [row.request, row.status])).toEqual([
      [`did:dkg:join-request:${CG}:0x${'4'.padStart(40, '0')}`, '"rejected"'],
      [`did:dkg:join-request:${CG}:0x${'5'.padStart(40, '0')}`, '"approved"'],
      [`did:dkg:join-request:${CG}:0x${'6'.padStart(40, '0')}`, '"pending"'],
    ]);
    await store.close();
  });

  it('ranks terminal decisions by decision time, falling back to request time', async () => {
    const store = new OxigraphStore();
    await store.insert([
      // An old request approved most recently must survive even though its
      // request timestamp is older than every other terminal record.
      ...requestQuads(1, 'approved', { requestTimestamp: 1, decisionTimestamp: 1_000 }),
      // Legacy rows without a decision timestamp retain request-time ordering.
      ...requestQuads(2, 'rejected', { requestTimestamp: 900 }),
      // Requester-local decisions may have no original request timestamp; the
      // terminal decision timestamp alone still makes them retainable.
      ...requestQuads(3, 'approved', { requestTimestamp: null, decisionTimestamp: 950 }),
    ]);

    await expect(pruneTerminalJoinRequestRecords(store, CG, 2)).resolves.toBeUndefined();

    const result = await store.query(`
      SELECT ?request WHERE {
        GRAPH <${META}> { ?request <${STATUS}> ?status }
      }
      ORDER BY ?request
    `);
    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') return;
    expect(result.bindings.map((row) => row.request)).toEqual([
      `did:dkg:join-request:${CG}:0x${'1'.padStart(40, '0')}`,
      `did:dkg:join-request:${CG}:0x${'3'.padStart(40, '0')}`,
    ]);
    await store.close();
  });

  it('skips pruning when the store cannot atomically recheck terminal state', async () => {
    const store = new OxigraphStore();
    await store.insert([
      ...requestQuads(1, 'approved'),
      ...requestQuads(2, 'rejected'),
    ]);
    const legacyStore = {
      query: store.query.bind(store),
    } as unknown as TripleStore;

    await expect(pruneTerminalJoinRequestRecords(legacyStore, CG, 1)).resolves.toBeUndefined();
    expect((await rowsForStatus(store)).map((row) => row.request)).toHaveLength(2);
    await store.close();
  });
});

async function rowsForStatus(store: TripleStore): Promise<Array<Record<string, string>>> {
  const result = await store.query(`
    SELECT ?request WHERE {
      GRAPH <${META}> { ?request <${STATUS}> ?status }
    }
    ORDER BY ?request
  `);
  return result.type === 'bindings' ? result.bindings : [];
}
