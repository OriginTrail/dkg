/**
 * GH#3134 — the capacity rule of an author catalog, its typed refusal, and how the repair
 * diagnostics and the retry class treat it. The rows here are synthetic (a UAL each), so the rule
 * is exercised at the real 1,024-row cap without building a catalog.
 */
import { describe, expect, it } from 'vitest';
import { MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 } from '@origintrail-official/dkg-core';

import {
  AUTHOR_CATALOG_FULL_CODE_V1,
  AuthorCatalogFullErrorV1,
  assertAuthorCatalogTakesNewRowsV1,
  findAuthorCatalogFullErrorV1,
} from '../src/internal/author-catalog-capacity.js';
import { FULL_CATALOG_RECHECK_INTERVAL_MS_V1 } from '../src/internal/full-catalog-parking.js';
import {
  catalogRepairDiagnosticV1,
  catalogRepairErrorSummaryV1,
  observeCatalogRepairStageV1,
} from '../src/rfc64/catalog-repair-diagnostics-v1.js';
import {
  CATALOG_FULL_RETRY_INTERVAL_MS_V1,
  CatalogRepairRetryV1,
} from '../src/rfc64/catalog-repair-retry-v1.js';
import { Rfc64SwmInventoryCatalogReconcilerErrorV1 } from '../src/rfc64/swm-inventory-catalog-reconciler-v1.js';

const CAP = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;
const rows = (count: number) => Array.from(
  { length: count },
  (_value, index) => ({ seal: { kaUal: `did:dkg:otp:20430/0x${'11'.repeat(20)}/${index + 1}` } }),
);

describe('author catalog capacity', () => {
  it('takes new rows up to the cap and refuses the row past it', () => {
    expect(CAP).toBe(1_024);
    expect(() => assertAuthorCatalogTakesNewRowsV1(rows(0), CAP)).not.toThrow();
    expect(() => assertAuthorCatalogTakesNewRowsV1(rows(CAP - 1), 1)).not.toThrow();
    expect(() => assertAuthorCatalogTakesNewRowsV1(rows(CAP), 1)).toThrow(AuthorCatalogFullErrorV1);
    expect(() => assertAuthorCatalogTakesNewRowsV1(rows(CAP - 3), 4)).toThrow(AuthorCatalogFullErrorV1);
  });

  it('never refuses a change that asks for no new row: a replacement, or a removal', () => {
    expect(() => assertAuthorCatalogTakesNewRowsV1(rows(CAP), 0)).not.toThrow();
    expect(() => assertAuthorCatalogTakesNewRowsV1(rows(CAP), -1)).not.toThrow();
  });

  it('says what the catalog holds, and names no asset in its message', () => {
    const held = rows(CAP);
    let refusal: unknown;
    try {
      assertAuthorCatalogTakesNewRowsV1(held, 2, 'applied-head');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AuthorCatalogFullErrorV1);
    expect(refusal).toMatchObject({
      name: 'AuthorCatalogFullErrorV1',
      code: 'catalog-full',
      rowCount: CAP,
      rowCap: CAP,
      newRows: 2,
      appliedHeadDigest: 'applied-head',
      message: `RFC-64 author catalog holds ${CAP} of ${CAP} rows and cannot take 2 more`,
    });
    expect(AUTHOR_CATALOG_FULL_CODE_V1).toBe('catalog-full');
    const { heldKaUals } = refusal as AuthorCatalogFullErrorV1;
    expect(heldKaUals.size).toBe(CAP);
    expect(heldKaUals.has(held[0]!.seal.kaUal)).toBe(true);
    expect(heldKaUals.has(`${held[0]!.seal.kaUal}0000`)).toBe(false);
    // A refusal raised without an applied head (the pure planners) carries none.
    expect(new AuthorCatalogFullErrorV1(held, 1).appliedHeadDigest).toBeNull();
  });

  it('is found behind the errors that wrap it, and nowhere else', () => {
    const refusal = new AuthorCatalogFullErrorV1(rows(CAP), 1);
    expect(findAuthorCatalogFullErrorV1(refusal)).toBe(refusal);
    expect(findAuthorCatalogFullErrorV1(
      new Error('repair failed', { cause: new Error('mutation failed', { cause: refusal }) }),
    )).toBe(refusal);
    expect(findAuthorCatalogFullErrorV1(new Error('store timeout'))).toBeUndefined();
    expect(findAuthorCatalogFullErrorV1('catalog-full')).toBeUndefined();
    expect(findAuthorCatalogFullErrorV1(null)).toBeUndefined();
    // A look-alike is not the refusal: only the class is.
    expect(findAuthorCatalogFullErrorV1(Object.assign(new Error('x'), { code: 'catalog-full' }))).toBeUndefined();

    const loop = new Error('loop');
    Reflect.set(loop, 'cause', loop);
    expect(findAuthorCatalogFullErrorV1(loop)).toBeUndefined();
    const hostile = Object.defineProperty(new Error('hostile'), 'cause', {
      get() { throw new Error('getter'); },
    });
    expect(findAuthorCatalogFullErrorV1(hostile)).toBeUndefined();
    let deep: Error = refusal;
    for (let depth = 0; depth < 8; depth++) deep = new Error(`layer ${depth}`, { cause: deep });
    expect(findAuthorCatalogFullErrorV1(deep)).toBeUndefined();
  });
});

describe('a full catalog in the repair diagnostics', () => {
  it('has a kind of its own, on both paths that can refuse for capacity', async () => {
    const refusal = new AuthorCatalogFullErrorV1(rows(CAP), 1);
    expect(catalogRepairDiagnosticV1(refusal)).toEqual({
      kind: 'catalog_full', stage: 'unknown', source: 'unknown', stageElapsedMs: null,
    });
    expect(catalogRepairDiagnosticV1(new Error('placement failed', { cause: refusal })).kind).toBe('catalog_full');
    // The projection target's own bound: an inventory with more rows than a catalog holds.
    expect(catalogRepairDiagnosticV1(new Rfc64SwmInventoryCatalogReconcilerErrorV1(
      'swm-catalog-reconcile-capacity', 'bounded catalog target exceeds its rows',
    )).kind).toBe('catalog_full');
    expect(catalogRepairErrorSummaryV1(refusal)).toBe('RFC-64 catalog repair catalog_full (stage: unknown)');

    const staged = await observeCatalogRepairStageV1('vm_projection', async () => { throw refusal; })
      .catch((error: unknown) => error);
    expect(catalogRepairDiagnosticV1(staged)).toMatchObject({ kind: 'catalog_full', stage: 'vm_projection' });
  });

  it('leaves every other capacity-sounding failure where it was', () => {
    expect(catalogRepairDiagnosticV1(new RangeError('RFC-64 exact-set target assets exceeds 1024 assets')).kind)
      .toBe('unknown');
    expect(catalogRepairDiagnosticV1(new Rfc64SwmInventoryCatalogReconcilerErrorV1(
      'swm-catalog-reconcile-input', 'resolveAsset must be a function',
    )).kind).toBe('integrity');
  });
});

describe('a full catalog in the repair retry', () => {
  it('waits the long interval instead of the failure back-off', () => {
    expect(CATALOG_FULL_RETRY_INTERVAL_MS_V1).toBe(60 * 60_000);
    expect(FULL_CATALOG_RECHECK_INTERVAL_MS_V1).toBe(CATALOG_FULL_RETRY_INTERVAL_MS_V1);
    const retry = new CatalogRepairRetryV1();
    retry.observe({ scopeIdentity: 'scope', headRevision: 'head-1' });
    for (let failure = 1; failure <= 3; failure++) {
      const now = failure * 1_000;
      expect(retry.fail(retry.generation, now, 5_000, 'catalog_full')).toBe(true);
      expect(retry.consecutiveFailures).toBe(failure);
      expect(retry.nextAttemptAtMs).toBe(now + CATALOG_FULL_RETRY_INTERVAL_MS_V1);
    }
    expect(retry.eligible(3_000 + CATALOG_FULL_RETRY_INTERVAL_MS_V1 - 1)).toBe(false);
    expect(retry.eligible(3_000 + CATALOG_FULL_RETRY_INTERVAL_MS_V1)).toBe(true);
    // Any other failure keeps the ordinary back-off.
    const other = new CatalogRepairRetryV1();
    expect(other.fail(other.generation, 0, 5_000, 'unknown')).toBe(true);
    expect(other.nextAttemptAtMs).toBe(5_000);
  });

  it('lets a change of the inventory through at once: it may be a removal or a newer version', () => {
    const retry = new CatalogRepairRetryV1();
    retry.observe({ scopeIdentity: 'scope', headRevision: 'head-1' });
    retry.fail(retry.generation, 0, 5_000, 'catalog_full');
    expect(retry.eligible(60_000)).toBe(false);
    expect(retry.observe({ scopeIdentity: 'scope', headRevision: 'head-2' })).toBe(true);
    expect(retry.eligible(60_000)).toBe(true);
    expect(retry.consecutiveFailures).toBe(0);
  });
});
