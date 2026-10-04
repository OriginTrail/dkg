import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { assertionLifecycleWriteLockKey, withKeyedLocks, type KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { decodeLifecycleRepairJournal } from '../src/named-ka-vm-lifecycle-repair-journal.js';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const ROOT1 = 'ab'.repeat(32), ROOT2 = 'cd'.repeat(32), CG = 'locked-repair', NAME = 'asset';
const PACKED = (BigInt(AUTHOR) << 96n) | 1n;
const dirs: string[] = [], owners: Array<{ stop(): Promise<void> }> = [], stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(subGraphName?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-lifecycle-lock-fence-')); dirs.push(dir);
  const store = new OxigraphStore(join(dir, 'store.nq')); stores.push(store);
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.defineProperty(agent, 'peerId', { value: 'locked-repair-peer' });
  agent.config = { dataDir: dir }; agent.store = store; agent.writeLocks = new Map<string, Promise<void>>();
  agent.log = { warn: vi.fn(), info: vi.fn() };
  let current = 1;
  agent.chain = { getEvmChainId: vi.fn(async () => 31337n), getKnowledgeAssetsLifecycleAddress: vi.fn(async () => AUTHOR), readKnowledgeAssetVersionSnapshot: vi.fn(async () => ({
    latestRoot: current === 1 ? ROOT1 : ROOT2, rootCount: BigInt(current),
  })) };
  const input = { contextGraphId: CG, name: NAME, agentAddress: AUTHOR, subGraphName,
    packedKaId: PACKED, merkleRoot: ROOT1, assertionVersion: '1', publishedUal: 'did:dkg:mock/1', publicationDeployment: { chainId: '31337', lifecycleAddress: AUTHOR } };
  const newer = { ...input, merkleRoot: ROOT2, assertionVersion: '2', publishedUal: 'did:dkg:mock/2' };
  const key = assertionLifecycleWriteLockKey(CG, NAME, AUTHOR, subGraphName);
  const repair = agent.getOrCreateNamedKaVmLifecycleRepair(); owners.push(repair);
  const descriptor = () => store.query(`SELECT ?root ?ual WHERE { GRAPH <${contextGraphMetaUri(CG)}> {
    <${assertionLifecycleUri(CG, AUTHOR, NAME, subGraphName)}> <http://dkg.io/ontology/vmCurrentAssertion> ?root ;
      <http://dkg.io/ontology/publishedUal> ?ual } }`);
  const journal = async () => decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
  return { dir, store, agent, input, newer, key, repair, descriptor, journal, advance: () => { current = 2; } };
}
describe('confirmed lifecycle lock-time authority fence', () => {
  it.each([undefined, 'private-lane'])('cannot regress a newer stamp while the old repair waits, lane=%s', async lane => {
    const f = await fixture(lane);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const stamping = withKeyedLocks(f.agent.writeLocks, [f.key], async () => {
      entered(); await held; f.advance(); await applyPublishedNamedKaVmLifecycle(f.store, f.newer);
    });
    await started;
    const predecessor = f.agent.writeLocks.get(f.key);
    const old = f.repair.submit(f.input);
    try { await vi.waitFor(() => expect(f.agent.writeLocks.get(f.key)).not.toBe(predecessor)); }
    finally { release(); }
    await stamping;
    expect(await old).toBe('superseded');
    expect(await f.descriptor()).toMatchObject({ bindings: [{ root: JSON.stringify(ROOT2), ual: JSON.stringify(f.newer.publishedUal) }] });
    expect((await f.journal()).size).toBe(0);
    const reopen = new OxigraphStore(join(f.dir, 'store.nq')); stores.push(reopen);
    expect(await reopen.query(`ASK { GRAPH <${contextGraphMetaUri(CG)}> {
      <${assertionLifecycleUri(CG, AUTHOR, NAME, lane)}> <http://dkg.io/ontology/vmCurrentAssertion> ${JSON.stringify(ROOT2)} } }`)).toMatchObject({ value: true });
  });
  it('refuses an old admitted entry after a newer admission arrives while its lifecycle lock is held', async () => {
    const f = await fixture(); let release!: () => void;
    const commit = vi.spyOn(f.store, 'atomicUpdate');
    const held = new Promise<void>(resolve => { release = resolve; });
    const holder = withKeyedLocks(f.agent.writeLocks, [f.key], async () => { await held; });
    const predecessor = f.agent.writeLocks.get(f.key), old = f.repair.submit(f.input);
    let newer!: Promise<string>;
    try {
      await vi.waitFor(() => expect(f.agent.writeLocks.get(f.key)).not.toBe(predecessor));
      newer = f.repair.submit(f.newer);
      await vi.waitFor(async () => expect([...await f.journal()].map(([, value]) => value.input.assertionVersion)).toEqual(['2']));
    } finally { release(); }
    await holder;
    expect(await old).toBe('superseded'); expect(await newer).toBe('pending');
    expect(commit).not.toHaveBeenCalled();
    expect(await f.descriptor()).toMatchObject({ bindings: [] });
    expect([...await f.journal()].map(([, value]) => value.input.assertionVersion)).toEqual(['2']);
    f.advance(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
    await f.repair.runDue();
    expect(commit.mock.calls.every(([sparql]) => !sparql.includes(ROOT1))).toBe(true);
    expect(await f.descriptor()).toMatchObject({ bindings: [{ root: JSON.stringify(ROOT2), ual: JSON.stringify(f.newer.publishedUal) }] });
    expect((await f.journal()).size).toBe(0);
  });
  it.each(['standalone', 'durable-evm'] as const)('preserves missing chain-evidence policy for %s', async scenario => {
    const f = await fixture();
    delete f.agent.chain.readKnowledgeAssetVersionSnapshot;
    f.agent.chain.getEvmChainId = vi.fn(async () => 31337n);
    if (scenario === 'standalone') f.agent.config = {};
    const commit = vi.spyOn(f.store, 'atomicUpdate');
    expect(await f.repair.submit(f.input)).toBe(scenario === 'standalone' ? 'repaired' : 'pending');
    if (scenario === 'durable-evm') {
      expect(commit).not.toHaveBeenCalled(); expect((await f.journal()).size).toBe(1);
    } else {
      expect(await f.descriptor()).toMatchObject({ bindings: [{ root: JSON.stringify(ROOT1) }] });
      expect((await f.journal()).size).toBe(0);
    }
  });
  it.each(['current', 'newer', 'unfinalized', 'conflicting-root', 'chain-error', 'replaced-workspace'] as const)(
    'retains coherent recovered queued behavior for %s', async scenario => {
      const f = await fixture();
      f.agent._canStampRecoveredKnowledgeAssetVmLifecycle = vi.fn(async () => scenario !== 'replaced-workspace');
      if (scenario === 'newer') f.advance();
      if (scenario === 'unfinalized') f.agent.chain.readKnowledgeAssetVersionSnapshot.mockResolvedValue({ latestRoot: ROOT1, rootCount: 0n });
      if (scenario === 'conflicting-root') f.agent.chain.readKnowledgeAssetVersionSnapshot.mockResolvedValue({ latestRoot: ROOT2, rootCount: 1n });
      if (scenario === 'chain-error') f.agent.chain.readKnowledgeAssetVersionSnapshot.mockRejectedValue(new Error('chain temporarily unavailable'));
      const request = { ...f.input, sealMerkleRoot: ROOT1, shareOperationId: 'own-operation', sealChainId: '31337', sealKav10Address: AUTHOR } as unknown as KnowledgeAssetVmPublishRequest;
      const commit = vi.spyOn(f.store, 'atomicUpdate');
      const queued = f.agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(request, f.input.publishedUal, PACKED);
      if (scenario === 'current') {
        expect(await queued).toBe(true);
        expect(await f.descriptor()).toMatchObject({ bindings: [{ root: JSON.stringify(ROOT1), ual: JSON.stringify(f.input.publishedUal) }] });
      } else {
        if (scenario === 'newer' || scenario === 'replaced-workspace') expect(await queued).toBe(false);
        else await expect(queued).rejects.toThrow();
        expect(commit).not.toHaveBeenCalled(); expect(await f.descriptor()).toMatchObject({ bindings: [] });
      }
    },
  );
  it('rechecks recovered queued currency inside its lifecycle lock', async () => {
    const f = await fixture();
    f.agent._canStampRecoveredKnowledgeAssetVmLifecycle = vi.fn(async () => true);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const holder = withKeyedLocks(f.agent.writeLocks, [f.key], async () => {
      await held; f.advance(); await applyPublishedNamedKaVmLifecycle(f.store, f.newer);
    });
    const predecessor = f.agent.writeLocks.get(f.key);
    const request = { ...f.input, sealMerkleRoot: ROOT1, shareOperationId: 'old-operation', sealChainId: '31337', sealKav10Address: AUTHOR } as unknown as KnowledgeAssetVmPublishRequest;
    const queued = f.agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(request, f.input.publishedUal, PACKED);
    try { await vi.waitFor(() => expect(f.agent.writeLocks.get(f.key)).not.toBe(predecessor)); }
    finally { release(); }
    await holder; expect(await queued).toBe(false);
    expect(await f.descriptor()).toMatchObject({ bindings: [{ root: JSON.stringify(ROOT2), ual: JSON.stringify(f.newer.publishedUal) }] });
  });
});
