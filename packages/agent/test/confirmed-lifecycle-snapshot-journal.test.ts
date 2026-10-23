import { createHash } from 'node:crypto';
import { assertCanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import { historicalLifecycleRepairJournal } from './_helpers/historical-lifecycle-repair-journal.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hexlify } from 'ethers';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { NamedKaVmLifecycleIntegrityError } from '../src/named-ka-vm-lifecycle-integrity-error.js';
import { DurableReplaceableFile } from '../src/durable-file-replace.js';
import { NamedKaVmLifecycleSnapshots } from '../src/named-ka-vm-lifecycle-snapshots.js';
import { readLifecycleRepairJournalFile } from './_helpers/read-lifecycle-repair-journal.js';
import { encodeLifecycleRepairJournal, lifecycleRepairKey } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';

function checkedSeal(value: unknown) {
  assertCanonicalGraphScopedAuthorSealV1(value); return Object.freeze({ ...value });
}
const dirs: string[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.stop(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-lifecycle-snapshots-')); dirs.push(dir);
  const input = confirmedMaterializationFixture().input;
  return { dir, input, path: join(dir, 'named-ka-vm-lifecycle-repairs.json'), snapshots: join(dir, 'named-ka-vm-lifecycle-snapshots') };
}
function owner(dir: string, apply: ConstructorParameters<typeof NamedKaVmLifecycleRepair>[0]['apply']) {
  const repair = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), now: () => 100_000, isCurrent: async () => true, apply, warn: () => {} });
  owners.push(repair); return repair;
}
it('writes immutable payload once and settling another entry only rewrites compact bookkeeping', async () => {
  const { dir, input: base, path, snapshots } = await setup();
  const publicQuads = [{ ...base.materialization!.publicQuads[0], object: JSON.stringify('payload-'.repeat(10_000)) }];
  const root = hexlify(computeFlatKCRootV10(publicQuads, []));
  const input = { ...base, merkleRoot: root, namedSeal: checkedSeal({ ...base.namedSeal!, assertionMerkleRoot: root }), materialization: { ...base.materialization!, publicQuads,
    metadataQuads: base.materialization!.metadataQuads.map(q => q.predicate === 'http://dkg.io/ontology/merkleRoot' ? { ...q, object: JSON.stringify(root.slice(2)) } : q) } };
  const repair = owner(dir, async value => { if (value.name === input.name) throw new NamedKaVmLifecycleIntegrityError('retained rejected evidence'); });
  expect(await repair.submit(input)).toBe('rejected');
  const [file] = await readdir(snapshots), before = await stat(join(snapshots, file), { bigint: true });
  const writes = vi.spyOn(DurableReplaceableFile.prototype, 'replace');
  const { materialization: _snapshot, ...other } = input;
  expect(await repair.submit({ ...other, name: 'independent' })).toBe('repaired');
  expect(writes).toHaveBeenCalledTimes(2);
  for (const [chunks] of writes.mock.calls) { const bytes = typeof chunks === 'string' ? chunks : [...chunks].join(''); expect(bytes.length).toBeLessThan(12_000); expect(bytes).not.toContain('payload-payload-'); }
  const after = await stat(join(snapshots, file), { bigint: true }); expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ino).toBe(before.ino);
  const journal = JSON.parse(await readFile(path, 'utf8')); expect(journal.version).toBe(4);
  expect(journal.entries[0][1].input).toHaveProperty('materializationRef'); expect(journal.entries[0][1].input).not.toHaveProperty('materialization');
  const restored = await readLifecycleRepairJournalFile(path); expect([...restored.values()][0]!.input.materialization!.publicQuads).toEqual(publicQuads);
});
it('retains the snapshot across uncertain journal admission, then recovers and removes it after durable settlement', async () => {
  const { dir, input, path, snapshots } = await setup();
  const original = DurableReplaceableFile.prototype.replace;
  let fail = true;
  vi.spyOn(DurableReplaceableFile.prototype, 'replace').mockImplementation(async function(this: DurableReplaceableFile, chunks) {
    const bytes = typeof chunks === 'string' ? chunks : [...chunks].join('');
    await original.call(this, bytes);
    if (fail && JSON.parse(bytes).version === 4) { fail = false; throw new Error('journal directory sync uncertain'); }
  });
  const apply = vi.fn(async () => {}), first = owner(dir, apply);
  await expect(first.submit(input)).rejects.toThrow('journal directory sync uncertain'); expect(apply).not.toHaveBeenCalled();
  expect(await readdir(snapshots)).toHaveLength(1); await first.stop();
  const retry = owner(dir, async value => { expect(value.materialization!.publicQuads).toEqual(input.materialization!.publicQuads); });
  await retry.runDue(); expect((await readLifecycleRepairJournalFile(path)).size).toBe(0); expect(await readdir(snapshots)).toHaveLength(0);
});
it.each(['missing', 'tampered'] as const)('fails closed when an admitted snapshot is %s and retains its obligation', async mode => {
  const { dir, input, path, snapshots } = await setup();
  const first = owner(dir, async () => { throw new Error('pressure'); }); expect(await first.submit(input)).toBe('pending'); await first.stop();
  const originalJournal = await readFile(path, 'utf8'), [file] = await readdir(snapshots);
  if (mode === 'missing') await rm(join(snapshots, file)); else await writeFile(join(snapshots, file), '{}');
  const apply = vi.fn(async () => {}), retry = owner(dir, apply);
  await expect(retry.runDue()).rejects.toThrow(); expect(apply).not.toHaveBeenCalled(); expect(await readFile(path, 'utf8')).toBe(originalJournal);
});
it('migrates version-3 inline evidence without losing its payload on another failed attempt', async () => {
  const { dir, input, path, snapshots } = await setup(), normalized = normalizeLifecycleRepairInput(input);
  await writeFile(path, JSON.stringify(historicalLifecycleRepairJournal(new Map([[lifecycleRepairKey(normalized), { input: normalized, attempts: 0, nextAttemptAt: 0 }]]))));
  const repair = owner(dir, async () => { throw new Error('retry pressure'); }); await repair.runDue();
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(4); expect(await readdir(snapshots)).toHaveLength(1);
  expect([...(await readLifecycleRepairJournalFile(path)).values()][0]!.input.materialization).toEqual(normalized.materialization);
});
it('does not write a journal or apply graphs when snapshot durability fails', async () => {
  const { dir, input, path } = await setup();
  vi.spyOn(DurableReplaceableFile.prototype, 'replace').mockRejectedValueOnce(new Error('snapshot fsync failed'));
  const apply = vi.fn(async () => {}), repair = owner(dir, apply);
  await expect(repair.submit(input)).rejects.toThrow('snapshot fsync failed'); expect(apply).not.toHaveBeenCalled();
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recreates a retired snapshot before referencing the same immutable object again', async () => {
  const { dir, input, snapshots } = await setup(), store = new NamedKaVmLifecycleSnapshots(dir);
  const normalized = normalizeLifecycleRepairInput(input);
  const entries = new Map([[lifecycleRepairKey(normalized), { input: normalized, attempts: 0, nextAttemptAt: 0 }]]);
  await store.encode(entries);
  await store.retireUnreferenced(new Map());
  expect(await readdir(snapshots)).toHaveLength(0);
  const journal = await store.encode(entries);
  expect(await readdir(snapshots)).toHaveLength(1);
  expect([...(await new NamedKaVmLifecycleSnapshots(dir).decode(journal)).values()][0]!.input.materialization).toEqual(normalized.materialization);
});


it.each(['key', 'retry', 'version', 'tuple'] as const)('rejects malformed %s before attempting snapshot I/O', async field => {
  const { dir, input } = await setup(), normalized = normalizeLifecycleRepairInput(input);
  const references = new Map([[normalized.materialization!, 'ab'.repeat(32)]]);
  const wire = encodeLifecycleRepairJournal(new Map([[lifecycleRepairKey(normalized), {
    input: normalized, attempts: 0, nextAttemptAt: 0,
  }]]), entry => references.get(entry.input.materialization!));
  const malformed = JSON.parse(JSON.stringify(wire));
  if (field === 'key') malformed.entries[0][0] = 'invalid';
  if (field === 'retry') malformed.entries[0][1].attempts = -1;
  if (field === 'version') malformed.version = 3;
  if (field === 'tuple') malformed.entries[0].push('unexpected');
  // No snapshot exists: opening the file before validating the wire would throw ENOENT.
  await expect(new NamedKaVmLifecycleSnapshots(dir).decode(malformed)).rejects.toBeInstanceOf(NamedKaVmLifecycleIntegrityError);
});

it('hydrates typed references into immutable evidence and reuses their verified reference on encoding', async () => {
  const { dir, input } = await setup(), normalized = normalizeLifecycleRepairInput(input);
  const entries = new Map([[lifecycleRepairKey(normalized), { input: normalized, attempts: 0, nextAttemptAt: 0 }]]);
  const wire = await new NamedKaVmLifecycleSnapshots(dir).encode(entries);
  const reopened = new NamedKaVmLifecycleSnapshots(dir), decoded = await reopened.decode(wire);
  const restored = [...decoded.values()][0]!.input.materialization!;
  expect(restored).toEqual(normalized.materialization); expect(Object.isFrozen(restored)).toBe(true);
  expect(Object.isFrozen(restored.publicQuads[0])).toBe(true);
  const command = [...decoded.values()][0]!.input;
  expect(command).not.toHaveProperty('namedSealQuads');
  expect(command).toHaveProperty('namedSeal.assertionVersion', '1');
  expect(Object.isFrozen((command as typeof normalized).namedSeal)).toBe(true);
  expect(wire.entries[0][1].input).not.toHaveProperty('namedSeal');
  expect(wire.entries[0][1].input.namedSealQuads).toBeDefined();
  const writes = vi.spyOn(DurableReplaceableFile.prototype, 'replace');
  expect(await reopened.encode(decoded)).toEqual(wire); expect(writes).not.toHaveBeenCalled();
});

it.each([false, true])('durably upgrades a loaded seal-less obligation before restart recovery, resubmitted snapshot=%s', async includeSnapshot => {
  const { dir, input, path } = await setup();
  const { namedSeal: _seal, ...legacy } = input;
  const first = owner(dir, async () => { throw new Error('original named seal unavailable'); });
  expect(await first.submit(legacy)).toBe('pending'); await first.stop();
  const admitted = vi.fn(async () => { throw new Error('held store pressure after upgraded admission'); });
  const second = owner(dir, admitted);
  expect(await second.submit(includeSnapshot ? input : { ...input, materialization: undefined })).toBe('pending');
  expect(admitted).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(path, 'utf8')).entries[0][1].input.namedSealQuads.length).toBeGreaterThan(0);
  await second.stop();
  const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
  const { applyMaterializedConfirmedLifecycle } = await import('../src/named-ka-vm-lifecycle-materialization.js');
  const { createGraphKnowledgeAssetScope, MemoryLayer, knowledgeAssetLayerGraphUri } = await import('@origintrail-official/dkg-core');
  const storePath = join(dir, 'recovered.nq'), store = new OxigraphStore(storePath);
  const third = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), now: () => 200_000,
    isCurrent: async () => true, warn: () => {}, apply: value => applyMaterializedConfirmedLifecycle(store, value, { persistence: 'restart-durable' }) }); owners.push(third);
  try {
    await third.runDue(); expect((await readLifecycleRepairJournalFile(path)).size).toBe(0);
    const reopened = new OxigraphStore(storePath);
    try {
      const graph = knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(input.materialization!.kaUal, input.assertionVersion));
      expect(await reopened.countQuads(graph)).toBe(input.materialization!.publicQuads.length);
      expect(await reopened.query(`ASK { GRAPH <did:dkg:context-graph:${input.contextGraphId}/_meta> { ?s <http://dkg.io/ontology/reservedUal> ${JSON.stringify(input.materialization!.kaUal)} } }`)).toMatchObject({ value: true });
    } finally { await reopened.close(); }
  } finally { await third.stop(); await store.close(); }
});

it.each(['identity', 'snapshot', 'seal'])('rejects contradictory same-version %s evidence without changing the retained obligation', async field => {
  const { dir, input, path } = await setup();
  const repair = owner(dir, async () => { throw new Error('pressure'); });
  expect(await repair.submit(input)).toBe('pending');
  const bytes = await readFile(path, 'utf8');
  const changed = field === 'identity' ? { ...input, packedKaId: input.packedKaId + 1n, materialization: undefined, namedSeal: undefined }
    : field === 'snapshot' ? { ...input, materialization: { ...input.materialization!, metadataQuads: input.materialization!.metadataQuads.map(q => q.predicate === 'http://dkg.io/ontology/publisherPeerId' ? { ...q, object: '"another-publisher"' } : q) } }
    : { ...input, namedSeal: checkedSeal({ ...input.namedSeal!, assertionFinalizedAt: '2026-02-01T00:00:00.000Z' }) };
  expect(changed).not.toEqual(input);
  await expect(repair.submit(changed)).rejects.toBeInstanceOf(NamedKaVmLifecycleIntegrityError);
  expect(await readFile(path, 'utf8')).toBe(bytes);
});

it.each(['subject', 'graph', 'extra', 'duplicate', 'model'])('rejects malformed named seal wire %s before snapshot I/O', async field => {
  const { dir, input } = await setup(), command = normalizeLifecycleRepairInput(input);
  const wire = JSON.parse(JSON.stringify(encodeLifecycleRepairJournal(new Map([[lifecycleRepairKey(command), {
    input: command, attempts: 0, nextAttemptAt: 0,
  }]]), () => 'ab'.repeat(32))));
  const stored = wire.entries[0][1].input, rows = stored.namedSealQuads;
  if (field === 'subject') rows[0].subject = 'urn:wrong';
  if (field === 'graph') rows[0].graph = 'urn:wrong';
  if (field === 'extra') rows.push({ ...rows[0], predicate: 'urn:unexpected' });
  if (field === 'duplicate') rows.push(rows[0]);
  if (field === 'model') stored.namedSeal = command.namedSeal;
  await expect(new NamedKaVmLifecycleSnapshots(dir).decode(wire)).rejects.toBeInstanceOf(NamedKaVmLifecycleIntegrityError);
});


it('preserves an adopted snapshot hash even when its original wire bytes use different formatting', async () => {
  const { dir, input, snapshots } = await setup(), command = normalizeLifecycleRepairInput(input);
  const entries = new Map([[lifecycleRepairKey(command), { input: command, attempts: 1, nextAttemptAt: 0 }]]);
  const wire = await new NamedKaVmLifecycleSnapshots(dir).encode(entries);
  const original = wire.entries[0][1].input.materializationRef!;
  const pretty = JSON.stringify(JSON.parse(await readFile(join(snapshots, `${original}.json`), 'utf8')), null, 2);
  const adoptedRef = createHash('sha256').update(pretty).digest('hex'); expect(adoptedRef).not.toBe(original);
  await new DurableReplaceableFile(join(snapshots, `${adoptedRef}.json`), { fileMode: 0o600, directoryMode: 0o700 }).replace(pretty);
  wire.entries[0][1].input.materializationRef = adoptedRef;
  const reopened = new NamedKaVmLifecycleSnapshots(dir), decoded = await reopened.decode(wire);
  const writes = vi.spyOn(DurableReplaceableFile.prototype, 'replace');
  expect(await reopened.encode(decoded)).toEqual(wire); expect(writes).not.toHaveBeenCalled();
  expect(await readFile(join(snapshots, `${adoptedRef}.json`), 'utf8')).toBe(pretty);
});
