import type {
  ContextGraphChainScanOptions,
  ContextGraphRegistryScanOptions,
} from '@origintrail-official/dkg-chain';

type DiscoveryScanMode = ContextGraphRegistryScanOptions['mode'] | 'listAll';

/**
 * Public discovery options retain the historical boolean aliases, but a
 * caller must choose either those aliases or the canonical mode. The agent
 * converts this boundary shape once before entering its scan machinery.
 */
export type DiscoverContextGraphsFromChainOptions = {
  signal?: AbortSignal;
  throwOnChainScanFailure?: boolean;
  pageBudget?: number;
  minimumIntervalMs?: number;
} & (
  | {
      mode: DiscoveryScanMode;
      incremental?: never;
      seedIncrementalWatermark?: never;
      resumeFromCursor?: never;
    }
  | {
      mode?: never;
      incremental?: boolean;
      seedIncrementalWatermark?: boolean;
      resumeFromCursor?: boolean;
    }
);

export type NormalizedContextGraphDiscoveryScan =
  | { mode: 'listAll' }
  | { mode: 'incremental'; pageBudget?: number }
  | { mode: 'seedFull' }
  | { mode: 'seedFromCursor'; pageBudget?: number }
  | { mode: 'seedLiveTail'; pageBudget?: number }
  | { mode: 'repair'; pageBudget: number; minimumIntervalMs?: number };

export function normalizeContextGraphDiscoveryScan(
  options: DiscoverContextGraphsFromChainOptions,
): NormalizedContextGraphDiscoveryScan {
  const legacyFlags = [
    options.incremental,
    options.seedIncrementalWatermark,
    options.resumeFromCursor,
  ];
  if (options.mode !== undefined && legacyFlags.some((value) => value !== undefined)) {
    throw new Error(
      'Context graph discovery mode cannot be combined with legacy scan flags',
    );
  }
  if (options.incremental === true && options.seedIncrementalWatermark === true) {
    throw new Error(
      'Context graph discovery cannot be both incremental and a watermark seed',
    );
  }
  if (options.resumeFromCursor === true && options.seedIncrementalWatermark === undefined) {
    throw new Error(
      'resumeFromCursor requires seedIncrementalWatermark',
    );
  }

  if (options.mode === 'repair') {
    return {
      mode: 'repair',
      pageBudget: options.pageBudget ?? 1,
      ...(options.minimumIntervalMs !== undefined
        ? { minimumIntervalMs: options.minimumIntervalMs }
        : {}),
    };
  }
  if (options.mode === 'seedLiveTail') {
    return {
      mode: 'seedLiveTail',
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }
  if (options.mode === 'incremental') {
    return {
      mode: 'incremental',
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }
  if (options.mode === 'seedFull') return { mode: 'seedFull' };
  if (options.mode === 'seedFromCursor') {
    return {
      mode: 'seedFromCursor',
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }
  if (options.mode === 'listAll') return { mode: 'listAll' };

  if (options.incremental === true) {
    return {
      mode: 'incremental',
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }
  if (options.seedIncrementalWatermark === true) {
    return options.resumeFromCursor === true
      ? {
          mode: 'seedFromCursor',
          ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
        }
      : { mode: 'seedFull' };
  }
  return { mode: 'listAll' };
}

/** Translate canonical modes only when an older chain adapter is used. */
export function legacyChainListScanOptions(
  scan: NormalizedContextGraphDiscoveryScan,
): ContextGraphChainScanOptions | undefined {
  switch (scan.mode) {
    case 'listAll':
    case 'seedLiveTail':
    case 'repair':
      return undefined;
    case 'incremental':
      return {
        incremental: true,
        ...(scan.pageBudget !== undefined ? { pageBudget: scan.pageBudget } : {}),
      };
    case 'seedFull':
      return { seedIncrementalWatermark: true };
    case 'seedFromCursor':
      return {
        seedIncrementalWatermark: true,
        resumeFromCursor: true,
        ...(scan.pageBudget !== undefined ? { pageBudget: scan.pageBudget } : {}),
      };
  }
}
