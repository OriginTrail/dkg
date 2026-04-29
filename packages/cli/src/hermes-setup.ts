import type { Command } from 'commander';

export type HermesMemoryMode = 'primary' | 'tools-only';

export interface HermesSetupCliOptions {
  profile?: string;
  daemonUrl?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  bridgeHealthUrl?: string;
  port?: string | number;
  memoryMode?: HermesMemoryMode;
  verify?: boolean;
  start?: boolean;
  dryRun?: boolean;
}

export interface NormalizedHermesSetupOptions {
  profile?: string;
  daemonUrl?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  bridgeHealthUrl?: string;
  port?: number;
  memoryMode?: HermesMemoryMode;
  verify: boolean;
  start: boolean;
  dryRun: boolean;
}

export interface HermesSetupActionDeps {
  runSetup: (opts: NormalizedHermesSetupOptions) => Promise<void>;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePort(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Hermes daemon port: ${String(value)}`);
  }
  return port;
}

export function normalizeHermesSetupOptions(opts: HermesSetupCliOptions): NormalizedHermesSetupOptions {
  const memoryMode = trimmed(opts.memoryMode);
  if (
    memoryMode !== undefined
    && memoryMode !== 'primary'
    && memoryMode !== 'tools-only'
  ) {
    throw new Error(`Invalid Hermes memory mode: ${memoryMode}`);
  }

  return {
    profile: trimmed(opts.profile),
    daemonUrl: trimmed(opts.daemonUrl),
    bridgeUrl: trimmed(opts.bridgeUrl),
    gatewayUrl: trimmed(opts.gatewayUrl),
    bridgeHealthUrl: trimmed(opts.bridgeHealthUrl),
    port: normalizePort(opts.port),
    memoryMode,
    verify: opts.verify !== false,
    start: opts.start !== false,
    dryRun: opts.dryRun === true,
  };
}

export async function hermesSetupAction(
  opts: HermesSetupCliOptions,
  _command: Pick<Command, 'getOptionValueSource'>,
  deps: HermesSetupActionDeps,
): Promise<void> {
  await deps.runSetup(normalizeHermesSetupOptions(opts));
}
