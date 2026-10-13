// SPDX-License-Identifier: Apache-2.0

import { performance } from 'node:perf_hooks';
import {
  ExactGraphReadError,
  isStoreOperationTimeoutError,
  isStoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';

const SOURCES = {
  seal: 'agent.rfc64.swmInventory.catalogReconcile.seal',
  workspace_head: 'catalog.workspace_head',
  public_snapshot: 'catalog.public_snapshot',
  vm_metadata: 'catalog.vm_metadata',
  vm_projection: 'catalog.vm_projection',
  projection_validation: 'catalog.projection_validation',
} as const;
type CatalogRepairStageV1 = keyof typeof SOURCES;
type CatalogRepairFailureKindV1 =
  | 'queue_wait' | 'queue_full' | 'store_timeout_not_started'
  | 'store_timeout_indeterminate' | 'transport' | 'cancelled'
  | 'integrity' | 'lane_inactive' | 'catalog_full' | 'unknown';

export interface CatalogRepairDiagnosticV1 {
  readonly kind: CatalogRepairFailureKindV1;
  readonly stage: CatalogRepairStageV1 | 'unknown';
  readonly source: string;
  /** Whole helper elapsed time, including queue wait; never pure execution time. */
  readonly stageElapsedMs: number | null;
}

export class CatalogRepairLaneInactiveErrorV1 extends Error {
  constructor() { super('RFC-64 catalog repair lane is temporarily inactive'); }
}

export class CatalogRepairIntegrityErrorV1 extends Error {}

class CatalogRepairStageErrorV1 extends Error {
  constructor(
    readonly stage: CatalogRepairStageV1,
    readonly elapsedMs: number,
    cause: unknown,
  ) {
    // Preserve internal resolver messages for callers; diagnostics never emit them.
    let message = 'RFC-64 catalog asset resolution failed';
    try { if (cause instanceof Error) message = cause.message; } catch { /* hostile getter */ }
    super(message, { cause });
  }
}

export async function observeCatalogRepairStageV1<T>(
  stage: CatalogRepairStageV1,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } catch (cause) {
    throw new CatalogRepairStageErrorV1(stage, Math.max(0, performance.now() - started), cause);
  }
}

const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const INTEGRITY_CODES = new Set(['swm-catalog-reconcile-signature', 'swm-catalog-reconcile-binding', 'swm-catalog-reconcile-input']);
// GH#3134 — the catalog has no row for a new asset, or the inventory to project is larger than a catalog.
const CAPACITY_CODES = new Set(['catalog-full', 'swm-catalog-reconcile-capacity']);

/** Only closed classifications escape; never copy arbitrary message/name/code/source. */
export function catalogRepairDiagnosticV1(error: unknown): Readonly<CatalogRepairDiagnosticV1> {
  let kind: CatalogRepairFailureKindV1 = 'unknown';
  let stage: CatalogRepairStageV1 | 'unknown' = 'unknown';
  let stageElapsedMs: number | null = null;
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    try {
      if (current instanceof CatalogRepairStageErrorV1) {
        if (Object.hasOwn(SOURCES, current.stage)) {
          stage = current.stage;
          stageElapsedMs = Number.isFinite(current.elapsedMs) && current.elapsedMs >= 0
            ? Math.round(current.elapsedMs) : null;
        }
      }
      if (current instanceof CatalogRepairLaneInactiveErrorV1) kind = 'lane_inactive';
      else if (current instanceof CatalogRepairIntegrityErrorV1
        || (current instanceof ExactGraphReadError && current.kind === 'integrity')) kind = 'integrity';
      else if (isStoreSchedulerBusyError(current)) kind = current.reason === 'queue_wait_timeout' ? 'queue_wait' : 'queue_full';
      else if (isStoreOperationTimeoutError(current)) kind = current.outcome === 'not_started' ? 'store_timeout_not_started' : 'store_timeout_indeterminate';
      else {
        const code = Reflect.get(current, 'code');
        if (typeof code === 'string' && INTEGRITY_CODES.has(code)) kind = 'integrity';
        else if (typeof code === 'string' && CAPACITY_CODES.has(code)) kind = 'catalog_full';
        else if (typeof code === 'string' && TRANSPORT_CODES.has(code)) kind = 'transport';
        else if (Reflect.get(current, 'name') === 'AbortError') kind = 'cancelled';
      }
      current = Reflect.get(current, 'cause');
    } catch {
      break;
    }
  }
  return Object.freeze({ kind, stage, source: stage === 'unknown' ? 'unknown' : SOURCES[stage], stageElapsedMs });
}

export function catalogRepairErrorSummaryV1(error: unknown): string {
  const diagnostic = catalogRepairDiagnosticV1(error);
  return `RFC-64 catalog repair ${diagnostic.kind} (stage: ${diagnostic.stage})`;
}
