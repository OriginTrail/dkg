import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePublicGraphSnapshot, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { CheckpointInventory } from '../src/snapshot-checkpoint-inventory.js';
import { makeSnapshotAssets, sealSnapshotOf } from './helpers/public-snapshot-assets.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function folder() { const path = await mkdtemp(join(tmpdir(), 'checkpoint-inventory-')); folders.push(path); return path; }
function observation(count = 2, blockNumber = '10', changes = {}) {
  const sealed = sealPublicGraphSnapshot({ ...sealSnapshotOf('graph', makeSnapshotAssets('graph', count)), blockNumber, ...changes });
  return { mode: 'rpc-only' as const, sourceCore: null, snapshot: normalizePublicGraphSnapshot(sealed, { ...sealed, now: sealed.observedAt }) };
}

it.each(['removal', 'chain', 'deployment', 'graph', 'storage', 'mode', 'anchor', 'hash'])(
  'refuses %s before advancing a retained checkpoint inventory', async change => {
    const path = await folder(), initial = observation();
    const inventory = await CheckpointInventory.create(path, initial);
    const next = observation(change === 'removal' ? 1 : 2, change === 'anchor' ? '9' : '10');
    const fresh = change === 'chain' ? { ...next, snapshot: { ...next.snapshot, chainId: 'base:8453' } }
      : change === 'deployment' ? { ...next, snapshot: { ...next.snapshot, deploymentId: 'other' } }
      : change === 'graph' ? { ...next, snapshot: { ...next.snapshot, contextGraphId: 'other' } }
      : change === 'storage' ? { ...next, snapshot: { ...next.snapshot, assetStorage: `0x${'cd'.repeat(20)}` } }
      : change === 'mode' ? { ...next, mode: 'core-cache' as const, sourceCore: 'core' }
      : change === 'hash' ? { ...next, snapshot: { ...next.snapshot, blockHash: `0x${'b'.repeat(64)}` } } : next;
    await expect(inventory.advance(fresh)).rejects.toThrow(/removed|scope|anchor/);
    expect(JSON.parse(await readFile(join(path, 'AUTHENTICATED-INVENTORY.json'), 'utf8'))).toEqual(initial);
  });

it('loads expired historical pins only as a comparison floor, never as new authority', async () => {
  const path = await folder(), old = observation(2, '10', { observedAt: 1000, expiresAt: 121000 });
  await CheckpointInventory.create(path, old);
  const resumed = await CheckpointInventory.load(path);
  await expect(resumed.advance(observation(1, '11'))).rejects.toThrow('removed');
  await resumed.advance(observation(2, '11'));
});

it.each(['missing', 'oversized', 'malformed', 'symlink'])('fails closed on a %s inventory record', async kind => {
  const path = await folder(), file = join(path, 'AUTHENTICATED-INVENTORY.json');
  if (kind === 'oversized') await writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1025));
  if (kind === 'malformed') await writeFile(file, '{}');
  if (kind === 'symlink') { const other = join(path, 'other'); await writeFile(other, '{}'); await symlink(other, file); }
  await expect(CheckpointInventory.load(path)).rejects.toThrow();
});
