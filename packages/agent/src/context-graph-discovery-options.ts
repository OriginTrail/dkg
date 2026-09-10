import type { ContextGraphChainScanOptions, ContextGraphRegistryScanOptions, NormalizedContextGraphScanRequest as NormalizedContextGraphDiscoveryScan } from '@origintrail-official/dkg-chain';

type DiscoveryScanMode = 'listAll' | ContextGraphRegistryScanOptions['mode'];
export type DiscoverContextGraphsFromChainOptions = {
  throwOnChainScanFailure?: boolean;
  pageBudget?: number;
} & (
  | { mode: DiscoveryScanMode; incremental?: never; seedIncrementalWatermark?: never; resumeFromCursor?: never }
  | { mode?: never; incremental?: boolean; seedIncrementalWatermark?: boolean; resumeFromCursor?: boolean }
);

export { decodeContextGraphScanRequest as normalizeContextGraphDiscoveryScan } from '@origintrail-official/dkg-chain';
export type { NormalizedContextGraphScanRequest as NormalizedContextGraphDiscoveryScan } from '@origintrail-official/dkg-chain';

/** Only older adapters need booleans, translated at their outbound API boundary. */
export function legacyChainListScanOptions(scan: NormalizedContextGraphDiscoveryScan): ContextGraphChainScanOptions | undefined {
  switch (scan.mode) {
    case 'listAll': return undefined;
    case 'incremental': return { incremental: true, ...(scan.pageBudget !== undefined ? { pageBudget: scan.pageBudget } : {}) };
    case 'seedFull': return { seedIncrementalWatermark: true };
    case 'seedFromCursor': return { seedIncrementalWatermark: true, resumeFromCursor: true, ...(scan.pageBudget !== undefined ? { pageBudget: scan.pageBudget } : {}) };
  }
}
