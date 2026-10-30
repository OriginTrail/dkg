import { daemonRuntimeState } from '../src/daemon/shutdown-wait.js';
import { startCheckpointStartupStatus } from '../src/daemon/public-checkpoint-status.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindCheckpointNetwork, checkDaemonCheckpointEligibility, decodeDaemonPublicCheckpointConfig } from '../src/daemon/public-checkpoint-config.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const spec = { version: 1 as const, source: { contextGraphId: 'graph', onChainId: '14', mode: 'core-cache' as const,
  trustedCorePeerIds: ['core'] }, runtime: { java: '/opt/java', jar: '/opt/runtime.jar', jarSha256: 'a'.repeat(64) } };
async function home() { const dir = await mkdtemp(join(tmpdir(), 'daemon-checkpoint-')); dirs.push(dir); return dir; }
describe('daemon native bootstrap eligibility', () => {
  it('leaves ordinary installations untouched and only admits a fresh explicit profile', async () => {
    const dir = await home(); await writeFile(join(dir, 'config.json'), '{}');
    vi.stubEnv('DKG_HOME', dir);
    // Exercise the actual startup claim before native eligibility, including shutdown ownership.
    await daemonRuntimeState.claim(process.pid, { hardTimeoutMs: 180000 });
    expect(await checkDaemonCheckpointEligibility(dir, { nodeRole: 'edge' })).toBeUndefined();
    expect(await checkDaemonCheckpointEligibility(dir, { nodeRole: 'edge', publicSnapshotBootstrap: spec })).toBe('fresh');
    await writeFile(join(dir, 'community.db'), 'preserved');
    await expect(checkDaemonCheckpointEligibility(dir, { nodeRole: 'edge', publicSnapshotBootstrap: spec })).rejects.toThrow('initialized');
    expect(await readFile(join(dir, 'community.db'), 'utf8')).toBe('preserved');
  });
  it('rejects existing store configuration and core role before touching data', async () => {
    const dir = await home();
    for (const config of [{ nodeRole: 'core' }, { nodeRole: 'edge', store: { backend: 'blazegraph' } }])
      await expect(checkDaemonCheckpointEligibility(dir, { ...config, publicSnapshotBootstrap: spec })).rejects.toThrow('fresh Edge');
  });
  it('routes retained journals only to strict resume validation and refuses symlinks', async () => {
    const dir = await home(), target = await home();
    await mkdir(join(dir, 'public-checkpoint-edge'));
    expect(await checkDaemonCheckpointEligibility(dir, { nodeRole: 'edge', publicSnapshotBootstrap: spec })).toBe('resume');
    await symlink(target, join(target, 'public-checkpoint-edge'));
    await expect(checkDaemonCheckpointEligibility(target, { nodeRole: 'edge', publicSnapshotBootstrap: spec })).rejects.toThrow('Unsafe');
  });
  it('rejects unpinned runtime paths and caller-owned deadline/transport', () => {
    expect(decodeDaemonPublicCheckpointConfig(spec).source.mode).toBe('core-cache');
    expect(() => decodeDaemonPublicCheckpointConfig({ ...spec, runtime: { ...spec.runtime, java: 'java' } })).toThrow('pinned');
    expect(() => decodeDaemonPublicCheckpointConfig({ ...spec, source: { ...spec.source, transport: 'bulk' } })).toThrow('owns');
  });
});

it('network binding cannot be reused across a testnet reset and never erases data', async () => {
  const dir = await home();
  const initial = { networkId: 'testnet', networkConfig: 'testnet-base', chainResetMarker: 'era-1' };
  await bindCheckpointNetwork(dir, 'fresh', initial);
  await bindCheckpointNetwork(dir, 'resume', initial);
  await expect(bindCheckpointNetwork(dir, 'resume', { ...initial, chainResetMarker: 'era-2' })).rejects.toThrow('not modified');
  expect(JSON.parse(await readFile(join(dir, 'public-checkpoint-network.json'), 'utf8'))).toEqual(initial);
});

it('startup listener proves liveness while refusing readiness and releases the API port', async () => {
  const status = await startCheckpointStartupStatus(0);
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/api/status`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false, state: 'public-bootstrap-starting' });
  } finally { await status.close(); }
  const rebound = await startCheckpointStartupStatus(status.port);
  await rebound.close(); await status.close();
});
