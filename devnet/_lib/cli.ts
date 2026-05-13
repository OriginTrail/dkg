/**
 * CLI subprocess + output parsing helpers shared by the devnet test
 * suites. The DKG CLI prints human-readable output (no `--json` flag),
 * so the test code parses key fields with regex. The previous helper
 * (in each suite, copy-pasted) was lossy: a `Status: confirmed` line
 * with a missing `KC ID:` line silently produced `kcId === undefined`,
 * which then masked downstream assertions.
 *
 * This module re-implements the same ergonomic shape but:
 *   - tightens regex anchors (whole-line),
 *   - validates that all expected fields are present for each status,
 *   - surfaces the full stdout/stderr in the thrown error so a CI run
 *     can immediately diagnose a publish that flipped to `tentative`,
 *   - kills the child on timeout AND surfaces "no output yet" hangs.
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

export interface DevnetNodeForCli {
  num: number;
  apiPort: number;
  home: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `node dist/cli.js …` against a devnet node. Always uses `process.execPath`
 * so the CLI runs in the same Node version that vitest is using
 * (avoids surprises if the dev has a global `node` on a different
 * version).
 */
export function runDkgCli(
  node: DevnetNodeForCli,
  args: string[],
  timeoutMs = 60_000,
): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const cliPath = join(REPO_ROOT, 'packages/cli/dist/cli.js');
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DKG_NO_BLUE_GREEN: '1',
        DKG_HOME: node.home,
        DKG_API_PORT: String(node.apiPort),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectResult(
        new Error(
          `dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}\n` +
            `partial stdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
  });
}

export interface PublishCliResult {
  status: 'confirmed' | 'tentative' | 'unknown';
  kcId?: bigint;
  txHash?: string;
  blockNumber?: bigint;
  publisher?: string;
  raw: string;
}

/**
 * Run `dkg publish <contextGraph> --file <path> [--publisher-node-identity-id <id>]`
 * and parse the well-formed printed output into a typed object.
 *
 * Strict parsing rules (these all matter — they're how a regression
 * surfaces):
 *
 *   - Exit code MUST be 0; non-zero exits throw with full stdout/stderr.
 *   - `Status:` line MUST be present; missing means the CLI changed.
 *   - For `Status: confirmed` we additionally require `KC ID:` AND
 *     `TX hash:`. A confirmed status without an on-chain anchor is a
 *     real bug (the publisher returned ok but the chain didn't see it).
 *   - For `Status: tentative` we accept `KC ID: 0` (sentinel for "not
 *     anchored yet") and a missing `TX hash:`.
 *
 * The parsed status is union-typed so downstream `expect(...).toBe('confirmed')`
 * is exhaustively type-checked.
 */
export async function publishViaCli(
  node: DevnetNodeForCli,
  contextGraph: string,
  filePath: string,
  options: { publisherNodeIdentityId?: bigint; timeoutMs?: number } = {},
): Promise<PublishCliResult> {
  const args = ['publish', contextGraph, '--file', filePath];
  if (options.publisherNodeIdentityId !== undefined) {
    args.push(
      '--publisher-node-identity-id',
      String(options.publisherNodeIdentityId),
    );
  }
  const result = await runDkgCli(node, args, options.timeoutMs ?? 60_000);
  if (result.code !== 0) {
    throw new Error(
      `dkg publish failed (exit ${result.code})\n` +
        `args: ${args.join(' ')}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    );
  }

  const stdout = result.stdout;
  const statusRaw = /^\s*Status:\s*(\w+)\s*$/mi.exec(stdout)?.[1];
  if (!statusRaw) {
    throw new Error(
      `dkg publish: missing 'Status:' line in CLI output. The CLI may have ` +
        `changed its output shape — update publishViaCli() in devnet/_lib/cli.ts.\n` +
        `stdout:\n${stdout}`,
    );
  }
  const status = (
    statusRaw.toLowerCase() === 'confirmed'
      ? 'confirmed'
      : statusRaw.toLowerCase() === 'tentative'
        ? 'tentative'
        : 'unknown'
  ) as PublishCliResult['status'];

  const kcMatch = /^\s*KC ID:\s*(\d+)\s*$/mi.exec(stdout);
  const txMatch = /^\s*TX hash:\s*(0x[0-9a-fA-F]+)\s*$/mi.exec(stdout);
  const blockMatch = /^\s*Block:\s*(\d+)\s*$/mi.exec(stdout);
  const publisherMatch = /^\s*Publisher:\s*(0x[0-9a-fA-F]+)\s*$/mi.exec(stdout);

  if (status === 'confirmed') {
    if (!kcMatch) {
      throw new Error(
        `dkg publish: status=confirmed but no 'KC ID:' line — the CLI claims ` +
          `success without an on-chain anchor. This is a real protocol bug.\n` +
          `stdout:\n${stdout}`,
      );
    }
    if (!txMatch) {
      throw new Error(
        `dkg publish: status=confirmed but no 'TX hash:' line. The publisher ` +
          `must have skipped the chain submit. Real protocol bug.\n` +
          `stdout:\n${stdout}`,
      );
    }
  }

  return {
    status,
    kcId: kcMatch ? BigInt(kcMatch[1]!) : undefined,
    txHash: txMatch?.[1],
    blockNumber: blockMatch ? BigInt(blockMatch[1]!) : undefined,
    publisher: publisherMatch?.[1],
    raw: stdout,
  };
}
