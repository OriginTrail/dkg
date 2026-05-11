import type { Command } from 'commander';
import { readFileSync } from 'node:fs';

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
  /**
   * Fund the generated admin and operational wallets via the testnet faucet on first setup.
   * Defaults to `true`; the adapter treats `fund === false` (set by
   * `--no-fund`) as the only opt-out. Faucet failures are non-fatal — a
   * failed call logs manual `curl` instructions and setup continues.
   * Mirrors OpenClaw `--fund` / `--no-fund` (issue #386 acceptance:
   * "`--no-fund` truly means do not perform faucet funding").
   */
  fund?: boolean;
  /**
   * Refuse to replace an existing non-DKG `memory.provider` in the Hermes
   * profile config. Default is `false` (replace-by-default per
   * setup-entrypoint-contract.md §2 + parity-matrix.md Layer 4). Set to
   * `true` via `--preserve-provider` (alias `--no-replace-provider`) to
   * restore the pre-#386 throw-on-conflict behavior.
   */
  preserveProvider?: boolean;
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
  fund: boolean;
  preserveProvider: boolean;
  dryRun: boolean;
  nodeSkillContent?: string;
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

export function loadBundledDkgNodeSkill(): string {
  return readFileSync(new URL('../skills/dkg-node/SKILL.md', import.meta.url), 'utf-8');
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
    // Commander boolean-flag convention: `--no-fund` produces `fund === false`,
    // anything else (omitted, explicit `--fund`) defaults to true.
    fund: opts.fund !== false,
    // Default replace-by-default per setup-entrypoint-contract.md §2.
    // `--preserve-provider` (alias `--no-replace-provider`) flips to true.
    preserveProvider: opts.preserveProvider === true,
    dryRun: opts.dryRun === true,
  };
}

export async function hermesSetupAction(
  opts: HermesSetupCliOptions,
  _command: Pick<Command, 'getOptionValueSource'>,
  deps: HermesSetupActionDeps,
): Promise<void> {
  await deps.runSetup({
    ...normalizeHermesSetupOptions(opts),
    nodeSkillContent: loadBundledDkgNodeSkill(),
  });
}
