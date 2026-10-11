import { describe, expect, it } from 'vitest';
import { ExactGraphReadError, StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import {
  CatalogRepairIntegrityErrorV1,
  CatalogRepairLaneInactiveErrorV1,
  catalogRepairDiagnosticV1,
  catalogRepairErrorSummaryV1,
  observeCatalogRepairStageV1,
} from '../src/rfc64/catalog-repair-diagnostics-v1.js';

const SECRET = 'private-graph-key-and-payload';

describe('catalog repair bounded cause attribution', () => {
  it.each([
    [new StoreSchedulerBusyError('queue_wait_timeout', 'background', SECRET), 'queue_wait'],
    [new StoreSchedulerBusyError('queue_full', 'background', SECRET), 'queue_full'],
    [new StoreOperationTimeoutError({ backend: SECRET, operation: SECRET, outcome: 'not_started' }), 'store_timeout_not_started'],
    [new StoreOperationTimeoutError({ backend: SECRET, operation: SECRET }), 'store_timeout_indeterminate'],
    [new CatalogRepairIntegrityErrorV1(SECRET), 'integrity'],
    [new ExactGraphReadError({ kind: 'limit', code: 'QUAD_COUNT_LIMIT_EXCEEDED', graphIri: SECRET, message: SECRET }), 'unknown'],
    [new CatalogRepairLaneInactiveErrorV1(), 'lane_inactive'],
    [Object.assign(new Error(SECRET), { name: 'AbortError' }), 'cancelled'],
    [new TypeError('fetch failed', { cause: Object.assign(new Error(SECRET), { code: 'ECONNRESET' }) }), 'transport'],
    [new TypeError('fetch failed'), 'unknown'],
  ])('retains a closed cause kind through resolver and reconciler wrappers', async (cause, kind) => {
    const error = await observeCatalogRepairStageV1('seal', async () => { throw cause; }).catch((error: unknown) => error);
    const outer = new Error(SECRET, { cause: error });
    const diagnostic = catalogRepairDiagnosticV1(outer);
    expect(diagnostic).toEqual({
      kind, stage: 'seal', source: 'agent.rfc64.swmInventory.catalogReconcile.seal',
      stageElapsedMs: expect.any(Number),
    });
    expect(diagnostic.stageElapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(diagnostic)).not.toContain(SECRET);
    expect(catalogRepairErrorSummaryV1(outer)).not.toContain(SECRET);
  });

  it('keeps the innermost stage when a public snapshot falls back to VM', async () => {
    const error = await observeCatalogRepairStageV1('public_snapshot', () => (
      observeCatalogRepairStageV1('vm_projection', async () => {
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'background', SECRET);
      })
    )).catch((error: unknown) => error);
    expect(catalogRepairDiagnosticV1(error)).toMatchObject({ kind: 'queue_wait', stage: 'vm_projection' });
  });

  it('bounds cause depth and cycles without copying arbitrary identity fields', () => {
    const cycle = { name: SECRET, code: SECRET, message: SECRET, cause: null as unknown };
    cycle.cause = cycle;
    expect(catalogRepairDiagnosticV1(cycle)).toEqual({ kind: 'unknown', stage: 'unknown', source: 'unknown', stageElapsedMs: null });
    let deep: unknown = new StoreSchedulerBusyError('queue_full', 'background', SECRET);
    for (let i = 0; i < 12; i++) deep = new Error(SECRET, { cause: deep });
    expect(catalogRepairDiagnosticV1(deep).kind).toBe('unknown');
  });

  it('contains hostile getters and proxy traps', async () => {
    for (const field of ['code', 'message', 'name', 'cause']) {
      const hostile = Object.defineProperty({}, field, { get: () => { throw new Error(SECRET); } });
      expect(() => catalogRepairDiagnosticV1(hostile)).not.toThrow();
      expect(JSON.stringify(catalogRepairDiagnosticV1(hostile))).not.toContain(SECRET);
    }
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error(SECRET); } });
    const error = await observeCatalogRepairStageV1('seal', async () => { throw hostile; }).catch((error: unknown) => error);
    expect(catalogRepairDiagnosticV1(error)).toMatchObject({ kind: 'unknown', stage: 'seal' });
  });
});
