import type { ContextGraphChainScanOptions, ContextGraphRegistryScanOptions } from '@origintrail-official/dkg-chain';

type DiscoveryScanMode = 'listAll' | ContextGraphRegistryScanOptions['mode'];
export type DiscoverContextGraphsFromChainOptions = {
  throwOnChainScanFailure?: boolean;
  pageBudget?: number;
} & (
  | { mode: DiscoveryScanMode; incremental?: never; seedIncrementalWatermark?: never; resumeFromCursor?: never }
  | { mode?: never; incremental?: boolean; seedIncrementalWatermark?: boolean; resumeFromCursor?: boolean }
);

export type NormalizedContextGraphDiscoveryScan = { mode: 'listAll' } | ContextGraphRegistryScanOptions;

/** Public compatibility boundary; internal discovery consumes only scan modes. */
export function normalizeContextGraphDiscoveryScan(options: DiscoverContextGraphsFromChainOptions): NormalizedContextGraphDiscoveryScan {
  if (options.mode !== undefined && [options.incremental, options.seedIncrementalWatermark, options.resumeFromCursor].some((value) => value !== undefined)) {
    throw new Error('Context graph discovery mode cannot be combined with legacy scan flags');
  }
  if (options.incremental === true && options.seedIncrementalWatermark === true) {
    throw new Error('Context graph discovery cannot be both incremental and a watermark seed');
  }
  if (options.resumeFromCursor === true && options.seedIncrementalWatermark === undefined) {
    throw new Error('resumeFromCursor requires seedIncrementalWatermark');
  }
  const mode = options.mode ?? (options.incremental === true ? 'incremental'
    : options.seedIncrementalWatermark === true ? (options.resumeFromCursor === true ? 'seedFromCursor' : 'seedFull')
      : 'listAll');
  switch (mode) {
    case 'listAll': return { mode };
    case 'seedFull': return { mode };
    case 'incremental':
    case 'seedFromCursor':
      return { mode, ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}) };
    default: throw new Error(`Unsupported context graph chain discovery scan mode: ${String(mode)}`);
  }
}

/** Only older adapters need booleans, translated at their outbound API boundary. */
export function legacyChainListScanOptions(scan: NormalizedContextGraphDiscoveryScan): ContextGraphChainScanOptions | undefined {
  switch (scan.mode) {
    case 'listAll': return undefined;
    case 'incremental': return { incremental: true, ...(scan.pageBudget !== undefined ? { pageBudget: scan.pageBudget } : {}) };
    case 'seedFull': return { seedIncrementalWatermark: true };
    case 'seedFromCursor': return { seedIncrementalWatermark: true, resumeFromCursor: true, ...(scan.pageBudget !== undefined ? { pageBudget: scan.pageBudget } : {}) };
  }
}
