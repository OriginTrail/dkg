import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import { resumePublicCheckpointEdge } from '../src/snapshot-resume-edge.js';
import { startSnapshotNativeProcess } from '../src/snapshot-native-process.js';
import { nativeCheckpointProperties } from '../src/snapshot-native-properties.js';
import { buildNativeSnapshotCheckpoint } from '../src/snapshot-native-build.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-boundary-')); directories.push(directory);
  const preparedDir = join(directory, 'prepared'); await mkdir(join(preparedDir, 'native'), { recursive: true });
  const journal = join(preparedDir, 'native/store.jnl'); await writeFile(journal, 'journal');
  const jar = join(directory, 'runtime.jar'); await writeFile(jar, 'runtime');
  const snapshot = { chainId: 'base:84532', deploymentId: 'test', contextGraphId: 'graph', onChainId: '14', inventoryDigest: 'inventory' };
  const options = {
    config: { dataDir: join(directory, 'edge'), chainAdapter: { chainId: snapshot.chainId, deploymentId: snapshot.deploymentId } },
    prepared: { directory: preparedDir, manifest: { deadline: Date.now() + 30_000, observation: { mode: 'rpc-only', snapshot } } },
    native: { state: 'verified-unpublished', fullReadback: true, inventoryDigest: snapshot.inventoryDigest,
      runtimeSha256: digest('runtime'), journal, journalSha256: digest('journal') },
    runtime: { java: process.execPath, jar, jarSha256: digest('runtime') },
    sync: { mode: 'rpc-only', contextGraphId: 'graph', onChainId: '14', trustedCorePeerIds: ['fixture'] },
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof createFreshPublicCheckpointEdge>[0];
  return { directory, options };
}

describe('native checkpoint ownership', () => {
  it('refuses an existing Edge without changing private or community state', async () => {
    const { options } = await fixture();
    await mkdir(options.config.dataDir);
    const files = ['private.nq', 'community.json', 'config.json'];
    for (const name of files) await writeFile(join(options.config.dataDir, name), `preserved ${name}`);
    await expect(createFreshPublicCheckpointEdge(options)).rejects.toThrow('EEXIST');
    expect(await readdir(options.config.dataDir)).toEqual([...files].sort());
    for (const name of files) expect(await readFile(join(options.config.dataDir, name), 'utf8')).toBe(`preserved ${name}`);
  });
  it.each(['chain', 'deployment', 'mode', 'graph', 'core', 'existing-store'] as const)('rejects a mismatched %s before creating the Edge', async mismatch => {
    const { directory, options } = await fixture();
    if (mismatch === 'chain') Object.defineProperty(options.config.chainAdapter, 'chainId', { value: 'wrong' });
    if (mismatch === 'deployment') Object.defineProperty(options.config.chainAdapter, 'deploymentId', { value: 'wrong' });
    if (mismatch === 'mode') options.sync.mode = 'core-cache';
    if (mismatch === 'graph') options.sync.contextGraphId = 'wrong';
    if (mismatch === 'core') options.config.nodeRole = 'core';
    if (mismatch === 'existing-store') options.config.store = {} as never;
    await expect(createFreshPublicCheckpointEdge(options)).rejects.toThrow('binding mismatch');
    expect(await readdir(directory)).not.toContain('edge');
  });
  it('rejects changed journal bytes and expired jobs without creating an Edge', async () => {
    const { directory, options } = await fixture();
    await writeFile(options.native.journal, 'changed');
    await expect(createFreshPublicCheckpointEdge(options)).rejects.toThrow('hash mismatch');
    options.prepared.manifest.deadline = Date.now() - 1;
    await expect(createFreshPublicCheckpointEdge(options)).rejects.toThrow('deadline');
    expect(await readdir(directory)).not.toContain('edge');
  });
  it('refuses restart without a successful, matching completion record', async () => {
    const { options } = await fixture();
    const folder = join(options.config.dataDir, 'checkpoint-store'); await mkdir(folder, { recursive: true });
    const resume = () => resumePublicCheckpointEdge(options);
    await expect(resume()).rejects.toThrow('ENOENT');
    await writeFile(join(folder, 'BOOTSTRAP-COMPLETE.json'), JSON.stringify({ version: 1, result: { current: false } }));
    await expect(resume()).rejects.toThrow('binding mismatch');
    expect(await readdir(folder)).toEqual(['BOOTSTRAP-COMPLETE.json']);
  });
  it('pins runtime bytes before creating a native load directory', async () => {
    const { options } = await fixture();
    await expect(buildNativeSnapshotCheckpoint(options.prepared, { ...options.runtime,
      jarSha256: '0'.repeat(64), signal: options.signal, assertInventoryCurrent: async () => {} })).rejects.toThrow('hash mismatch');
    expect(await readdir(join(options.prepared.directory, 'native'))).toEqual(['store.jnl']);
  });
  it('escapes local Unicode paths and rejects injected properties', () => {
    expect(nativeCheckpointProperties('/tmp/č/store.jnl')).toContain('/tmp/\\u010d/store.jnl');
    expect(() => nativeCheckpointProperties('/tmp/a\nunsafe=true')).toThrow('Invalid');
  });
  it('waits for the owned process to exit on cancellation and handles spawn errors', async () => {
    const { directory } = await fixture();
    const controller = new AbortController();
    const marker = join(directory, 'child.pid');
    const child = await startSnapshotNativeProcess(process.execPath, ['-e',
      "require('fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));setInterval(()=>{},1000)", marker],
    directory, join(directory, 'child.log'), controller.signal);
    try {
      await expect.poll(async () => readFile(marker, 'utf8'), { timeout: 5000 }).toMatch(/^\d+$/);
      const pid = Number(await readFile(marker, 'utf8'));
      controller.abort(new Error('cancelled'));
      await child.stop();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await child.stop(); }
    const missing = await startSnapshotNativeProcess(join(directory, 'missing'), [], directory,
      join(directory, 'missing.log'), new AbortController().signal);
    await expect(missing.closed).rejects.toThrow('ENOENT');
    await missing.stop();
  });
});
