import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildEpcisQuery } from '../src/query-builder.js';
import { handleEventsQuery } from '../src/handlers.js';
import { encodePageToken } from '../src/utils.js';
import { MAX_EPCIS_OFFSET, MAX_EPCIS_PAGE_SIZE } from '../src/pagination.js';

it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, MAX_EPCIS_OFFSET + 1])(
  'rejects invalid/deep builder offset %s', (offset) => {
    expect(() => buildEpcisQuery({ offset }, 'pagination')).toThrow('offset must be a safe integer');
  },
);
it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe page size %s', (limit) => {
  expect(() => buildEpcisQuery({ limit }, 'pagination')).toThrow('page size must be a safe integer');
});
it('bounds lookahead independently of the public page-size cap', () => {
  expect(buildEpcisQuery({ limit: MAX_EPCIS_PAGE_SIZE, offset: MAX_EPCIS_OFFSET }, 'pagination'))
    .toContain('LIMIT 1000\nOFFSET 10000');
  expect(buildEpcisQuery({ limit: MAX_EPCIS_PAGE_SIZE }, 'pagination', { lookahead: true })).toContain('LIMIT 1001');
});
it.each([
  `offset=${MAX_EPCIS_OFFSET + 1}`,
  `nextPageToken=${encodeURIComponent(encodePageToken(MAX_EPCIS_OFFSET + 1))}`,
  'offset=9007199254740992',
  `perPage=${'9'.repeat(400)}`,
])('returns 400 before querying for %s', async (params) => {
  let queries = 0;
  await expect(handleEventsQuery(new URLSearchParams(params), {
    contextGraphId: 'pagination', basePath: '/epcis/events',
    queryEngine: { query: async () => { queries++; return { bindings: [] }; } },
  })).rejects.toMatchObject({ statusCode: 400 });
  expect(queries).toBe(0);
});

describe('offset boundaries through real EPCIS queries', () => {
  const store = new OxigraphStore();
  const cg = 'pagination';
  beforeAll(async () => {
    const graph = `did:dkg:context-graph:${cg}`;
    const rows: Quad[] = Array.from({ length: MAX_EPCIS_OFFSET + 2 }, (_, index) => {
      const subject = `urn:event:${String(index).padStart(5, '0')}`;
      return [
        { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://gs1.github.io/EPCIS/ObjectEvent', graph },
        { subject, predicate: 'https://gs1.github.io/EPCIS/eventTime', object: '"2024-03-01T08:00:00Z"', graph },
        { subject, predicate: 'https://gs1.github.io/EPCIS/readPoint', object: `urn:readpoint:${String(index).padStart(5, '0')}`, graph },
        { subject: 'urn:body', predicate: 'https://gs1.github.io/EPCIS/eventList', object: subject, graph },
      ];
    }).flat();
    await store.insert(rows);
  });
  afterAll(() => store.close());
  const config = {
    contextGraphId: cg, basePath: '/epcis/events',
    queryEngine: { query: async (sparql: string) => {
      const result = await store.query(sparql);
      if (result.type !== 'bindings') throw new Error('Expected event bindings');
      return { bindings: result.bindings };
    } },
  };

  it('finds the next page at the maximum page size and follows its token without repeating events', async () => {
    const first = await handleEventsQuery(new URLSearchParams('perPage=1000'), config);
    expect(first.body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(1000);
    expect(first.headers?.link).toBeDefined();
    const nextUrl = first.headers!.link!.match(/^<([^>]+)>/)![1];
    const second = await handleEventsQuery(new URL(nextUrl, 'http://localhost').searchParams, config);
    expect(second.body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(1000);
    expect(first.body.epcisBody.queryResults.resultsBody.eventList[0].readPoint).toEqual({ id: 'urn:readpoint:00000' });
    expect(second.body.epcisBody.queryResults.resultsBody.eventList[0].readPoint).toEqual({ id: 'urn:readpoint:01000' });
  });

  it('returns the final rows at the offset ceiling when no continuation is needed', async () => {
    const last = await handleEventsQuery(new URLSearchParams('offset=10000&perPage=10'), config);
    expect(last.body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(2);
    expect(last.headers).toBeUndefined();
  });

  it('reports the ceiling explicitly instead of returning a broken next link or silently ending a broad query', async () => {
    await expect(handleEventsQuery(new URLSearchParams('offset=10000&perPage=1'), config))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('pagination limit reached') });
  });
});
