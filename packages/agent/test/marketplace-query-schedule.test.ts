/**
 * The `local-query` executor under the static query cost schedule (spec
 * §6.2): admission charged up front (OVER_MAX_UNITS before anything runs),
 * delivery = ceil(rows/100) over `countResultRows` of the SERVED value
 * (bindings + quads), and guard aborts (timeout, row cap, size cap) that
 * still owe admission — each recounted by the buyer's `recountQuery`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  QUERY_COST_SCHEDULE_V1_DIGEST,
  parseQueryServeResult,
  recountQuery,
} from '@origintrail-official/dkg-marketplace';
import { QUERY_OFFER_COST_PIN, createQueryExecutor, type MarketplaceQueryFn } from '../src/marketplace/executors.js';

const SPARQL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5'; // GV-8: admission 3
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;

async function run(queryFn: MarketplaceQueryFn, maxUnits: bigint, opts: Parameters<typeof createQueryExecutor>[1] = {}) {
  const executed = await createQueryExecutor(queryFn, opts).execute(encode({ sparql: SPARQL }), { maxUnits });
  const result = decode(executed.resultBytes);
  const recount = recountQuery({ sparql: SPARQL, offerQueryCost: QUERY_OFFER_COST_PIN, result, receiptServedUnits: executed.unitsServed });
  return { executed, result: result as { result: unknown; rowCount: number; metering: Record<string, unknown> }, recount };
}

describe('local-query executor — static cost schedule', () => {
  it('delivers admission + ceil(rows/100), and the buyer recount matches', async () => {
    const { executed, result, recount } = await run(async () => ({ result: { bindings: [{ s: '1' }, { s: '2' }, { s: '3' }] } }), 200n);
    expect(executed.unitsServed).toBe(4n);
    expect(result.metering).toEqual({ scheduleDigest: QUERY_COST_SCHEDULE_V1_DIGEST, admissionUnits: 3, deliveryUnits: 1, servedUnits: 4, rowCount: 3 });
    expect(parseQueryServeResult(result).ok).toBe(true);
    expect(recount).toEqual({ verdict: 'match', servedUnits: 4n, recountUnits: 4n });
  });

  it('counts rows from the served value (quads too), never the query fn rowCount', async () => {
    const { executed, result } = await run(async () => ({ rowCount: 0, result: { bindings: [], quads: [{ s: 'a' }, { s: 'b' }] } }), 200n);
    expect(result.rowCount).toBe(2);
    expect(executed.unitsServed).toBe(4n);
  });

  it('refuses OVER_MAX_UNITS before execution when maxUnits cannot cover admission', async () => {
    const queryFn = vi.fn(async () => ({ result: { bindings: [] } }));
    await expect(createQueryExecutor(queryFn).execute(encode({ sparql: SPARQL }), { maxUnits: 2n }))
      .rejects.toMatchObject({ code: 'OVER_MAX_UNITS' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('refuses a SPARQL over 8192 bytes as BAD_PAYLOAD before any analysis or execution', async () => {
    const queryFn = vi.fn(async () => ({ result: { bindings: [] } }));
    const huge = `SELECT ?s WHERE { ?s ?p ?o }${' '.repeat(8_200)}`;
    await expect(createQueryExecutor(queryFn).execute(encode({ sparql: huge }), { maxUnits: 1_000n }))
      .rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('a timeout aborts with admission only (signal-aware and signal-deaf query fns)', async () => {
    let aborted = false;
    const signalAware: MarketplaceQueryFn = (_sparql, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); });
    });
    const first = await run(signalAware, 200n, { guards: { timeoutMs: 30 } });
    expect(aborted).toBe(true);
    expect(first.executed.unitsServed).toBe(3n);
    expect(first.result).toMatchObject({ result: null, rowCount: 0, metering: { deliveryUnits: 0, servedUnits: 3, aborted: { reason: 'timeout' } } });
    expect(first.recount).toEqual({ verdict: 'match', servedUnits: 3n, recountUnits: 3n });

    const deaf: MarketplaceQueryFn = () => new Promise((resolve) => setTimeout(() => resolve({ result: { bindings: [] } }), 500));
    const second = await run(deaf, 200n, { guards: { timeoutMs: 30 } });
    expect(second.result.metering).toMatchObject({ aborted: { reason: 'timeout' } });
  });

  it('rows over the row cap (guard or affordability) abort with admission only', async () => {
    const rows = { result: { bindings: [{ s: 1 }, { s: 2 }, { s: 3 }] } };
    const guard = await run(async () => rows, 200n, { guards: { maxRows: 2 } });
    expect(guard.result.metering).toMatchObject({ servedUnits: 3, aborted: { reason: 'row-cap' } });
    // maxUnits == admission → the affordable row cap is 0.
    const afford = await run(async () => rows, 3n);
    expect(afford.result.metering).toMatchObject({ servedUnits: 3, aborted: { reason: 'row-cap' } });
    expect(afford.recount.verdict).toBe('match');
  });

  it('a result too large to deliver aborts size-cap before signing; a backend failure is EXECUTION_FAILED', async () => {
    const big = await run(async () => ({ result: { bindings: [{ s: 'x'.repeat(2_000) }] } }), 200n, { maxResultBytes: 512 });
    expect(big.result.metering).toMatchObject({ servedUnits: 3, aborted: { reason: 'size-cap' } });
    await expect(createQueryExecutor(async () => { throw new Error('store offline'); })
      .execute(encode({ sparql: SPARQL }), { maxUnits: 200n })).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
  });
});
