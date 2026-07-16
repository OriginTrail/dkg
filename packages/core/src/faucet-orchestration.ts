/**
 * `fundWalletsBestEffort` and the supporting `readWallets` / `readWalletsWithRetry`
 * / `logManualFundingInstructions` helpers — shared faucet flow for adapter
 * setup paths. Wraps the agent-agnostic `requestFaucetFunding` core helper
 * with wallet discovery, retry-after-daemon-start, and a manual-curl
 * fallback that prints when the faucet call fails or returns no funded
 * wallets.
 *
 * Moved here from `packages/adapter-openclaw/src/setup.ts` in S1 of issue
 * #386 because adapter-hermes also needs faucet parity (issue acceptance
 * criterion: "`--no-fund` truly means do not perform faucet funding"; H-AC-19
 * asserts the 5×1s retry semantics in S2).
 *
 * Retry semantics MUST stay 5×1s — the daemon writes `wallets.json`
 * asynchronously after `/api/status` responds OK, so the file is often
 * missing on the first read immediately after `startDaemon` returns.
 *
 * Faucet failures are non-fatal — the orchestrator never throws; on any
 * error it logs a `[setup] WARNING: ...` line and prints a ready-to-paste
 * `curl` block so the operator can fund wallets manually. Matches the
 * pre-extraction OpenClaw behavior verbatim.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDkgConfigHome } from './dkg-home.js';
import { FAUCET_WALLETS_PER_REQUEST, getFundableWalletAddresses, requestFaucetFunding } from './faucet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  console.log(`[setup] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[setup] WARNING: ${msg}`);
}

function dkgDir(): string {
  return resolveDkgConfigHome({ startDir: __dirname });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read the wallet addresses the daemon has written to `~/.dkg/wallets.json`.
 *
 * Returns an empty list (with a warning) when the file is missing or
 * malformed. Setup retries a few times after daemon start because the
 * daemon writes `wallets.json` asynchronously and may not have flushed it
 * by the time the health check passes.
 */
export function readWallets(): string[] {
  const walletsPath = join(dkgDir(), 'wallets.json');
  if (!existsSync(walletsPath)) {
    warn('wallets.json not found — daemon may not have started yet');
    return [];
  }

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(walletsPath, 'utf-8'));
  } catch {
    warn('wallets.json is malformed or still being written — skipping');
    return [];
  }
  const addresses = getFundableWalletAddresses(raw);
  if (addresses.length === 0) {
    warn('wallets.json has no operational wallets — skipping faucet funding');
    return [];
  }
  if (addresses.length) {
    log(`Wallets: ${addresses.join(', ')}`);
  }
  return addresses;
}

/**
 * Print a ready-to-paste `curl` block for manual faucet funding. Called
 * only on faucet failure; the caller is expected to continue (funding is
 * best-effort / non-fatal).
 *
 * Addresses are split into batches of 4 to match the faucet's per-request
 * cap. Including more wallets in one body would be rejected by the faucet.
 */
export function logManualFundingInstructions(addresses: string[], faucetUrl: string, mode: string): void {
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += FAUCET_WALLETS_PER_REQUEST) {
    batches.push(addresses.slice(i, i + FAUCET_WALLETS_PER_REQUEST));
  }
  console.log('\nTo fund wallets manually, run:');
  batches.forEach((batch, index) => {
    if (batches.length > 1) {
      console.log(`  # batch ${index + 1}/${batches.length}`);
    }
    console.log(`  curl -X POST "${faucetUrl}" \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -H "Idempotency-Key: $(date +%s)-${index + 1}" \\`);
    console.log(`    --data-raw '{"mode":"${mode}","wallets":${JSON.stringify(batch)}}'`);
  });
  if (batches.length > 1) {
    console.log(`\nNote: faucet supports up to ${FAUCET_WALLETS_PER_REQUEST} wallets per call; run each batch above.`);
  }
  console.log('');
}

/**
 * Read wallet addresses, retrying up to 5 times with a 1s delay between
 * attempts. The daemon writes `~/.dkg/wallets.json` asynchronously after
 * its health check passes, so the file is often missing on the first read
 * immediately after `startDaemon` returns.
 *
 * Defaults preserve production behavior: `sleep` for the real `setTimeout`
 * delay, `readWallets` for the real filesystem read. Both are injectable
 * so the retry accounting can be unit-tested without spawning a real
 * daemon (H-AC-19 will assert this in S2).
 */
export async function readWalletsWithRetry(
  sleepFn: (ms: number) => Promise<void> = sleep,
  readFn: () => string[] = readWallets,
): Promise<string[]> {
  let walletAddresses = readFn();
  for (let i = 0; i < 5 && !walletAddresses.length; i++) {
    await sleepFn(1_000);
    walletAddresses = readFn();
  }
  return walletAddresses;
}

/**
 * Network-config slice that `fundWalletsBestEffort` consumes. Adapters
 * pass their own `network.faucet` shape (loaded from `network/<env>.json`);
 * we only require the two fields we read.
 */
export interface FundWalletsNetworkConfig {
  faucet?: {
    url: string;
    mode: string;
  };
}

/**
 * Options for `fundWalletsBestEffort`. `didStartDaemon` controls whether
 * we retry the wallets.json read — only meaningful when setup just spun
 * up the daemon (`--no-start` paths skip the retry because the file
 * either already exists or never will).
 */
export interface FundWalletsBestEffortOptions {
  network: FundWalletsNetworkConfig;
  /** Stable seed for deterministic faucet idempotency keys. */
  idempotencySeed?: string;
  /** @deprecated Use `idempotencySeed`; the faucet request body omits `callerId`. */
  callerId?: string;
  didStartDaemon: boolean;
}

/**
 * Best-effort faucet funding for wallets discovered from
 * `~/.dkg/wallets.json`. Lifted verbatim from
 * `adapter-openclaw/src/setup.ts:1801-1840` so adapter-hermes can reuse
 * the exact same orchestration in S2.
 *
 * Behavior:
 *   - Logs and skips when `network.faucet.url` / `network.faucet.mode`
 *     is missing (matches the CLI parity decision).
 *   - Retries the wallet read 5×1s when `didStartDaemon` is true.
 *   - On faucet failure (HTTP error, thrown exception, `success === false`,
 *     partial success), logs a manual-curl block and continues — never
 *     throws. Setup is non-fatal on funding.
 *
 * Caller responsibilities (kept outside this helper to preserve the
 * pre-extraction control flow in `runSetup`):
 *   - `--dry-run` short-circuit (caller skips invoking this entirely).
 *   - `--no-fund` short-circuit (same).
 *   - `throwIfAborted` between setup steps (this helper is not signal-aware
 *     by design — keeps it simple; cancellation lives in the caller).
 */
export async function fundWalletsBestEffort(opts: FundWalletsBestEffortOptions): Promise<void> {
  const { network, didStartDaemon } = opts;
  const idempotencySeed = opts.idempotencySeed ?? opts.callerId ?? 'setup';
  const faucetUrl = network?.faucet?.url;
  const faucetMode = network?.faucet?.mode;
  if (!faucetUrl || !faucetMode) {
    log('Skipping wallet funding (no faucet configured in network config)');
    return;
  }

  // Retry only makes sense if we actually started the daemon this run —
  // with --no-start, the wallet file either exists already or never will.
  const walletAddresses = didStartDaemon
    ? await readWalletsWithRetry()
    : readWallets();
  if (walletAddresses.length === 0) {
    warn('No wallet addresses available to fund (daemon did not produce wallets.json)');
    return;
  }

  log('Funding wallets via testnet faucet...');
  try {
    const result = await requestFaucetFunding(faucetUrl, faucetMode, walletAddresses, idempotencySeed);
    if (result.success) {
      log(`Funded: ${result.funded.join(', ')}`);
      if (result.error) {
        warn(`Faucet partially completed: ${result.error}`);
        logManualFundingInstructions(
          result.failedWallets?.length ? result.failedWallets : walletAddresses,
          faucetUrl,
          faucetMode,
        );
      }
    } else {
      warn(`Faucet request did not fund any wallets${result.error ? ` (${result.error})` : ''}`);
      logManualFundingInstructions(walletAddresses, faucetUrl, faucetMode);
    }
  } catch (err: any) {
    warn(`Faucet call failed: ${err?.message ?? String(err)}`);
    logManualFundingInstructions(walletAddresses, faucetUrl, faucetMode);
  }
}
