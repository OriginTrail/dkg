import type { ContextGraphRegistryScanOptions } from './chain-adapter.js';

export type NormalizedContextGraphScanRequest = { mode: 'listAll' } | ContextGraphRegistryScanOptions;
type ScanEntryPoint = 'discovery' | 'list' | 'pages';

export function decodeContextGraphScanRequest(input: unknown, entryPoint: 'pages'): ContextGraphRegistryScanOptions;
export function decodeContextGraphScanRequest(input: unknown, entryPoint?: 'discovery' | 'list'): NormalizedContextGraphScanRequest;
/** Decode public scan compatibility once, before adapter initialization or RPCs. */
export function decodeContextGraphScanRequest(
  input: unknown,
  entryPoint: ScanEntryPoint = 'discovery',
): NormalizedContextGraphScanRequest {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('Context graph scan options must be an object');
  }
  const { mode, incremental, seedIncrementalWatermark, resumeFromCursor, pageBudget } =
    (input ?? {}) as Record<string, unknown>;
  const legacyFlags = { incremental, seedIncrementalWatermark, resumeFromCursor };
  for (const [name, value] of Object.entries(legacyFlags)) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`${name} must be a boolean`);
    }
  }
  if (mode !== undefined && Object.values(legacyFlags).some(value => value !== undefined)) {
    throw new Error('Context graph scan mode cannot be combined with legacy scan flags');
  }
  if (incremental === true && seedIncrementalWatermark === true) {
    throw new Error('Context graph scan cannot be both incremental and a watermark seed');
  }
  if (resumeFromCursor === true && seedIncrementalWatermark === undefined) {
    throw new Error('resumeFromCursor requires seedIncrementalWatermark');
  }
  const normalizedMode = mode !== undefined ? mode : (incremental === true ? 'incremental'
    : seedIncrementalWatermark === true ? (resumeFromCursor === true ? 'seedFromCursor' : 'seedFull')
      : 'listAll');
  if (normalizedMode !== 'listAll' && normalizedMode !== 'incremental'
      && normalizedMode !== 'seedFull' && normalizedMode !== 'seedFromCursor') {
    throw new Error(`Unsupported context graph scan mode: ${String(normalizedMode)}`);
  }
  if (entryPoint === 'list' && mode !== undefined && normalizedMode !== 'listAll') {
    throw new Error('listContextGraphsFromChain accepts only listAll or legacy boolean scan options; use scanContextGraphRegistryPages for cursor-backed daemon scans.');
  }
  if (entryPoint === 'pages' && (mode === undefined || normalizedMode === 'listAll')) {
    throw new Error('scanContextGraphRegistryPages requires an explicit cursor scan mode');
  }
  switch (normalizedMode) {
    case 'listAll': return { mode: 'listAll' };
    case 'seedFull': return { mode: 'seedFull' };
    case 'incremental':
    case 'seedFromCursor': {
      // Preserve the adapter's legacy budget behavior: floor usable values and
      // use the configured/default budget for invalid or sub-page values.
      const budget = typeof pageBudget === 'number' && Number.isFinite(pageBudget) && pageBudget >= 1
        ? Math.floor(pageBudget) : undefined;
      return { mode: normalizedMode, ...(budget === undefined ? {} : { pageBudget: budget }) };
    }
  }
}
