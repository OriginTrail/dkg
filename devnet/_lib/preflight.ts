/**
 * Devnet preflight assertions.
 *
 * Every devnet test suite has the same set of preconditions:
 *   1. `.devnet/` exists at the repo root,
 *   2. Hardhat is reachable on `http://127.0.0.1:8545`,
 *   3. The contracts deployment file `localhost_contracts.json` exists,
 *   4. Each expected `.devnet/node<i>/` is populated.
 *
 * Without an explicit preflight, a missing prerequisite produces cryptic
 * `ECONNREFUSED` or `ENOENT` errors deep inside `detectDevnet()`. The
 * preflight throws a short, actionable error that names the missing piece
 * AND the command the operator needs to run.
 *
 * This module is read-only — it never mutates devnet state. It's safe to
 * run at the start of every `beforeAll`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '../..');
export const RPC = 'http://127.0.0.1:8545';
export const DEVNET_DIR = join(REPO_ROOT, '.devnet');
export const CONTRACTS_PATH = join(
  REPO_ROOT,
  'packages/evm-module/deployments/localhost_contracts.json',
);

export interface PreflightOptions {
  /** Number of `.devnet/node<i>/` directories that must exist + be configured. */
  expectedNodes: number;
  /**
   * Optional. If set to a number > 0, the preflight will additionally
   * read `.devnet/node1/wallets.json` and verify each node home contains
   * a `wallets.json` (which the daemons require to start).
   */
  requireWallets?: boolean;
  /** Optional. Operator command shown in the error message. */
  startCommandHint?: string;
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(`devnet preflight: ${message}`);
    this.name = 'PreflightError';
  }
}

/**
 * Throws PreflightError if any precondition fails. On success, returns
 * the parsed Hub address from localhost_contracts.json (the one piece
 * every detectDevnet() needs first anyway).
 */
export async function assertDevnetReady(opts: PreflightOptions): Promise<{
  hubAddress: string;
}> {
  const startHint =
    opts.startCommandHint ?? `./scripts/devnet.sh clean && ./scripts/devnet.sh start ${opts.expectedNodes}`;
  if (!existsSync(DEVNET_DIR)) {
    throw new PreflightError(
      `${DEVNET_DIR} does not exist. Run \`${startHint}\` first.`,
    );
  }

  // Probe Hardhat AND verify the chainId is the localhost devnet's
  // (31337 = 0x7a69). The previous version only checked that the
  // RPC responded with *some* chainId, which would silently accept
  // a developer's misconfigured proxy pointing at a public testnet
  // (Sepolia/Polygon) — and the staking funding cheat codes would
  // either error out cryptically or, worse, succeed against the
  // wrong network.
  const HARDHAT_LOCALHOST_CHAIN_ID = '0x7a69'; // 31337
  let chainIdRaw: string | undefined;
  let probeError: unknown;
  try {
    const probe = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
    });
    if (probe.ok) {
      const j = (await probe.json()) as { result?: string };
      chainIdRaw = j.result;
    }
  } catch (err) {
    probeError = err;
  }
  if (!chainIdRaw) {
    throw new PreflightError(
      `Hardhat at ${RPC} is unreachable / not returning a chainId` +
        (probeError ? ` (${(probeError as Error).message})` : '') +
        `. Run \`${startHint}\` first.`,
    );
  }
  if (chainIdRaw.toLowerCase() !== HARDHAT_LOCALHOST_CHAIN_ID) {
    throw new PreflightError(
      `RPC at ${RPC} returned chainId=${chainIdRaw}, expected ${HARDHAT_LOCALHOST_CHAIN_ID} (Hardhat localhost). ` +
        `These devnet tests use Hardhat-only cheat codes (\`hardhat_setBalance\`, ` +
        `\`hardhat_setStorageAt\`, \`evm_setNextBlockTimestamp\`) which would either ` +
        `silently fail or perform destructive writes against a wrong network. ` +
        `Run \`${startHint}\` and ensure no proxy/forward is rerouting ${RPC}.`,
    );
  }

  if (!existsSync(CONTRACTS_PATH)) {
    throw new PreflightError(
      `${CONTRACTS_PATH} missing. The Hardhat deployment did not run; ` +
        `check \`./scripts/devnet.sh\` output or run \`${startHint}\`.`,
    );
  }
  const contractsJson = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8'));
  const hubAddress: string =
    contractsJson.contracts?.Hub?.evmAddress ?? contractsJson.Hub;
  if (!hubAddress) {
    throw new PreflightError(
      `Hub address missing from ${CONTRACTS_PATH}. Re-deploy the contracts (\`${startHint}\`).`,
    );
  }

  for (let i = 1; i <= opts.expectedNodes; i++) {
    const home = join(DEVNET_DIR, `node${i}`);
    if (!existsSync(home)) {
      throw new PreflightError(
        `${home} missing — expected ${opts.expectedNodes} nodes but only found ${i - 1}. Run \`${startHint}\`.`,
      );
    }
    if (opts.requireWallets) {
      const w = join(home, 'wallets.json');
      if (!existsSync(w)) {
        throw new PreflightError(
          `${w} missing. Daemon ${i} cannot have started — re-bootstrap with \`${startHint}\`.`,
        );
      }
    }
  }

  return { hubAddress };
}
