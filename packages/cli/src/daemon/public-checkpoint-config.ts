// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, readFile, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { normalizePublicSnapshotSyncOptions, type PublicCheckpointSourceOptions } from '@origintrail-official/dkg-agent';

export interface DaemonPublicCheckpointConfig {
  version: 1;
  source: PublicCheckpointSourceOptions;
  runtime: { java: string; jar: string; jarSha256: string };
}
export const CHECKPOINT_DAEMON_DIRECTORY = 'public-checkpoint-edge';
export function decodeDaemonPublicCheckpointConfig(input: unknown): DaemonPublicCheckpointConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid public snapshot bootstrap config');
  const value = input as Record<string, unknown>;
  const runtime = value.runtime as Partial<DaemonPublicCheckpointConfig['runtime']> | undefined;
  if (value.version !== 1 || !runtime || typeof runtime.java !== 'string' || !isAbsolute(runtime.java)
    || typeof runtime.jar !== 'string' || !isAbsolute(runtime.jar)
    || typeof runtime.jarSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(runtime.jarSha256)
    || Object.keys(value).some(k => !['version', 'source', 'runtime'].includes(k)))
    throw new Error('Public bootstrap requires a local pinned native runtime');
  const { signal: _signal, transport: _transport, ...source } = normalizePublicSnapshotSyncOptions(value.source);
  const supplied = value.source as Record<string, unknown>;
  if (supplied.signal !== undefined || supplied.transport !== undefined)
    throw new Error('Bootstrap owns its transport and deadline');
  return { version: 1, source, runtime: { java: runtime.java, jar: runtime.jar, jarSha256: runtime.jarSha256 } };
}

/** Before any daemon store/DB initialization. An opt-in never authorizes a store migration. */
export async function checkDaemonCheckpointEligibility(home: string, config: {
  publicSnapshotBootstrap?: DaemonPublicCheckpointConfig; nodeRole?: string; store?: unknown;
}): Promise<'fresh' | 'resume' | undefined> {
  if (!config.publicSnapshotBootstrap) return undefined;
  decodeDaemonPublicCheckpointConfig(config.publicSnapshotBootstrap);
  if (config.nodeRole !== 'edge' || config.store !== undefined)
    throw new Error('Public bootstrap requires a fresh Edge with no configured store');
  const folder = join(home, CHECKPOINT_DAEMON_DIRECTORY);
  const children = await readdir(home);
  if (children.includes(CHECKPOINT_DAEMON_DIRECTORY)) {
    if (!(await lstat(folder)).isDirectory()) throw new Error('Unsafe checkpoint Edge directory');
    // Restart validation (including completion, chain and runtime pins) is mandatory later.
    return 'resume';
  }
  // These are configuration/credentials and daemon-launch bookkeeping, never graph data.
  const initialFiles = new Set(['config.json', 'auth.token', 'daemon.pid', 'daemon.log', 'api.port', 'shutdown-policy.json',
    'blackbox-process-limits.json', 'identity.key', 'public-bootstrap-plan.json', 'wallets.json', 'agent-key.bin', 'private-key.bin', 'node-key.bin', 'keypair.bin']);
  for (const name of children) {
    if (!initialFiles.has(name) || !(await lstat(join(home, name))).isFile())
      throw new Error('Public bootstrap refuses an initialized or unknown data directory; use ordinary sync');
  }
  return 'fresh';
}

/** A testnet reset refuses this native store; it never erases retained Edge data. */
export async function bindCheckpointNetwork(home: string, mode: 'fresh' | 'resume', binding: {
  networkId: string; networkConfig: string; chainResetMarker?: string;
}) {
  const file = join(home, 'public-checkpoint-network.json');
  const expected = JSON.stringify(binding);
  if (mode === 'fresh') {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(expected); await handle.sync(); } finally { await handle.close(); }
  }
  else if ((await lstat(file)).isSymbolicLink() || await readFile(file, 'utf8') !== expected)
    throw new Error('Checkpoint network or reset marker changed; retained data was not modified');
}
