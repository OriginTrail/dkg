// SPDX-License-Identifier: Apache-2.0
/** Devnet restart/readiness adapters over the shared checked process owner. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { join } from 'node:path';
import { waitFor } from './harness';
import { DEFAULT_DEVNET_RPC, type DevnetPaths } from '../../scripts/lib/devnet-node-process-control.js';
export { NODE_PID_FILES, parsePid, readNodePidEntries, readNodePids, readProcessState, processStateIsGone, pidAlive, clearDeadNodePidFiles, sigkillProcesses, verifiedNodeProcesses, inspectPsProcessSync, isDaemonOfCheckout, verifiedNodePids, sigkillNodeProcesses, waitForPidsGone, stopNodeProcesses, DEFAULT_DEVNET_RPC } from '../../scripts/lib/devnet-node-process-control.js';
export type { DevnetPaths, NodePidEntry, SyncProcessInspector } from '../../scripts/lib/devnet-node-process-control.js';

/**
 * The Hardhat RPC URL node1's config records (`chain.rpcUrl`), or the devnet
 * default when the file or the field is missing.
 */
export function rpcUrlFromNode1Config(devnetDir: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(devnetDir, 'node1', 'config.json'), 'utf8'));
    if (cfg?.chain?.rpcUrl) return cfg.chain.rpcUrl;
  } catch { /* fall through */ }
  return DEFAULT_DEVNET_RPC;
}

/**
 * Port environment for `devnet.sh restart-node`, so a restart matches whatever
 * (possibly non-default) ports this devnet uses. The Hardhat port comes from
 * `rpcUrl`, which each suite chooses; the API and libp2p bases come from
 * node1's config. Throws if node1's config is missing.
 */
export function devnetPortEnv(devnetDir: string, rpcUrl: string): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(devnetDir, 'node1', 'config.json'), 'utf8'));
  return {
    HARDHAT_PORT: new URL(rpcUrl).port || '8545',
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

export interface NodeProbe {
  /** Sent as `Authorization: Bearer <token>` when set (an empty string is sent as is). */
  authToken?: string;
  /** Abort the request after this long; no timeout when unset. */
  timeoutMs?: number;
}

/**
 * True when `GET /api/status` on the node's API port answers 200. Same request
 * core-peers-features has always made for this (plain `node:http`, JSON
 * `Content-Type`, the bearer token when there is one, no timeout unless asked).
 */
export function nodeReachable(apiPort: number, probe: NodeProbe = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: 'GET',
        path: '/api/status',
        headers: {
          'Content-Type': 'application/json',
          ...(probe.authToken !== undefined ? { Authorization: `Bearer ${probe.authToken}` } : {}),
        },
        ...(probe.timeoutMs !== undefined ? { signal: AbortSignal.timeout(probe.timeoutMs) } : {}),
      },
      (res) => {
        res.on('error', () => resolve(false));
        res.on('end', () => resolve(res.statusCode === 200));
        res.resume(); // status only
      },
    );
    req.on('error', () => resolve(false));
    req.end();
  });
}

export interface RestartNodeOptions {
  num: number;
  /** The node's API port, probed for readiness. */
  apiPort: number;
  /** Source of `restart-node`'s HARDHAT_PORT: each suite's own choice (see `devnetPortEnv`). */
  rpcUrl: string;
  /** Names the readiness wait in its timeout error. */
  label: string;
  timeoutMs: number;
  pollIntervalMs: number;
  probe?: NodeProbe;
}

/** The restart command owns checked shutdown and start; the caller owns readiness. */
export async function restartNodeAndWait(paths: DevnetPaths, options: RestartNodeOptions): Promise<void> {
  await promisify(execFile)('bash', [join(paths.repoRoot, 'scripts/devnet.sh'), 'restart-node', String(options.num)], {
    cwd: paths.repoRoot,
    env: { ...process.env, DEVNET_DIR: paths.devnetDir, ...devnetPortEnv(paths.devnetDir, options.rpcUrl) },
  });
  await waitFor(options.label, options.timeoutMs, options.pollIntervalMs, async () =>
    (await nodeReachable(options.apiPort, options.probe)) ? true : null,
  );
}
