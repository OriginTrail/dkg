import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { isConfirmedNamedKaVmLifecycleCurrent } from '../src/named-ka-vm-lifecycle-current.js';
import { decodeLifecycleRepairJournal } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';
const dirs: string[] = [], stores: OxigraphStore[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const { input: fields, publication } = confirmedLifecycleRecoveryFixture();
  const input = { ...fields, packedKaId: (BigInt(fields.agentAddress) << 96n) | 1n,
    publicationDeployment: { chainId: publication.seal.chainId.toString(), lifecycleAddress: publication.seal.kav10Address } };
  const dir = await mkdtemp(join(tmpdir(), 'dkg-deployment-replay-')); dirs.push(dir);
  const store = new OxigraphStore(join(dir, 'store.nq')); stores.push(store);
  let now = 1000, chainId = 31337n, address = input.publicationDeployment.lifecycleAddress, rootCount = 1n, unavailable = true;
  const snapshot = vi.fn(async () => ({ latestRoot: input.merkleRoot, rootCount }));
  const chain = { getEvmChainId: vi.fn(async () => chainId), getKnowledgeAssetsLifecycleAddress: vi.fn(async () => address), readKnowledgeAssetVersionSnapshot: snapshot };
  const apply = vi.fn(async (current: typeof fields) => {
    if (unavailable) throw new Error('disk temporarily unavailable');
    await applyPublishedNamedKaVmLifecycle(store, current);
  });
  const create = () => {
    const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), now: () => now, warn: vi.fn(), apply,
      isCurrent: candidate => isConfirmedNamedKaVmLifecycleCurrent(chain, candidate, 1000, true) }); owners.push(owner); return owner;
  };
  const journal = async () => decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
  return { input, store, apply, snapshot, create, journal,
    configure: (id: bigint, contract: string, count: bigint) => { chainId = id; address = contract; rootCount = count; },
    ready: () => { unavailable = false; now += 400_000; } };
}
describe('confirmed lifecycle deployment-bound replay', () => {
  it.each([['another chain', 1n], ['another chain', 2n], ['another deployment', 1n], ['another deployment', 2n]] as const)(
    'retains the original journal against %s with unrelated rootCount=%s, then repairs on the original deployment', async (scenario, count) => {
      const f = await fixture(), first = f.create();
      expect(await first.submit(f.input)).toBe('pending'); await first.stop();
      const original = [...await f.journal()][0]![1].input; f.snapshot.mockClear(); f.apply.mockClear();
      f.configure(scenario === 'another chain' ? 8453n : 31337n,
        scenario === 'another deployment' ? '0x' + '33'.repeat(20) : f.input.publicationDeployment.lifecycleAddress, count);
      f.ready(); const replay = f.create(); await replay.runDue();
      expect(f.snapshot).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
      expect([...await f.journal()][0]![1].input).toEqual(original);
      f.configure(31337n, f.input.publicationDeployment.lifecycleAddress.toUpperCase().replace('0X', '0x'), 1n);
      f.ready(); await replay.runDue(); expect((await f.journal()).size).toBe(0);
      expect(await f.store.query(`ASK { GRAPH <${contextGraphMetaUri(f.input.contextGraphId)}> {
        <${assertionLifecycleUri(f.input.contextGraphId, f.input.agentAddress, f.input.name)}> <http://dkg.io/ontology/publishedUal> ${JSON.stringify(f.input.publishedUal)} } }`)).toMatchObject({ value: true });
    },
  );
  it('keeps same-coordinate evidence for different deployments instead of comparing their assertion versions', async () => {
    const f = await fixture(), owner = f.create();
    expect(await owner.submit(f.input)).toBe('pending');
    const other = { ...f.input, assertionVersion: '2', publicationDeployment: { ...f.input.publicationDeployment, lifecycleAddress: '0x' + '33'.repeat(20) } };
    expect(await owner.submit(other)).toBe('pending');
    expect((await f.journal()).size).toBe(2);
    f.ready(); await owner.runDue();
    expect([...await f.journal()].map(([, entry]) => entry.input.publicationDeployment)).toEqual([other.publicationDeployment]);
  });
  it('retains historical unbound evidence without reading a configured deployment snapshot', async () => {
    const f = await fixture(), owner = f.create();
    const { publicationDeployment: _deployment, ...unbound } = f.input;
    expect(await owner.submit(unbound)).toBe('pending'); f.snapshot.mockClear(); f.apply.mockClear();
    await owner.stop(); f.ready(); await f.create().runDue();
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect([...await f.journal()][0]![1].input).toMatchObject({ publishedUal: unbound.publishedUal });
  });
});
