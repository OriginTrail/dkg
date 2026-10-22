import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { NamedKaVmLifecycleSnapshots } from '../src/named-ka-vm-lifecycle-snapshots.js';
import { lifecycleRepairKey, lifecycleMaterializationWire, type LifecycleRepairEntry } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { normalizeLifecycleRepairInput, reconcileLifecycleRepairEvidence } from '../src/named-ka-vm-lifecycle-evidence.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';
import { DurableReplaceableFile } from '../src/durable-file-replace.js';

const io = vi.hoisted(() => ({ hold: null as Promise<void> | null, calls: 0, active: 0, max: 0,
  onSync: undefined as (() => void) | undefined, deleteHold: null as Promise<void> | null, deleting: false, deleteFailure: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), sync = file.sync.bind(file);
    if (args[1] === 'wx' && String(args[0]).includes(`${sep}named-ka-vm-lifecycle-snapshots${sep}`)) file.sync = async () => {
      io.calls++; io.active++; io.max = Math.max(io.max, io.active); io.onSync?.();
      try { await io.hold; await sync(); } finally { io.active--; }
    };
    return file;
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).includes(`${sep}named-ka-vm-lifecycle-snapshots${sep}`) && /[a-f0-9]{64}\.json$/.test(String(args[0]))) {
      io.deleting = true; await io.deleteHold;
      if (io.deleteFailure) throw Object.assign(new Error('optional cleanup EIO'), { code: 'EIO' });
    }
    return fs.unlink(...args);
  } };
});
const dirs: string[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => { vi.restoreAllMocks(); io.hold = null; io.deleteHold = null; io.onSync = undefined;
  for (const owner of owners.splice(0)) await owner.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  io.calls = 0; io.active = 0; io.max = 0; io.deleting = false; io.deleteFailure = false; });
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dkg-repair-preparation-'))); dirs.push(dir);
  const input = confirmedMaterializationFixture().input;
  let now = 1000;
  const apply = vi.fn(async (_input: typeof input) => {});
  const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), now: () => now, apply, isCurrent: async () => true, warn: vi.fn() }); owners.push(owner);
  const { materialization: _payload, namedSeal: _seal, ...coordinates } = input;
  const independent = { ...coordinates, name: 'independent', packedKaId: input.packedKaId + 1n, publishedUal: input.publishedUal.replace(/\/1$/, '/2') };
  return { dir, owner, input, independent, apply, advance: () => { now += 10_000; },
    journal: async () => JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')) };
}

it('admits and applies independent B while A waits on its first snapshot fsync', async () => {
  const f = await fixture(); let release!: () => void;
  io.hold = new Promise<void>(resolve => { release = resolve; });
  const a = f.owner.submit(f.input); await vi.waitFor(() => expect(io.calls).toBe(1));
  const b = f.owner.submit(f.independent); let completed = false; void b.then(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1000 });
    expect(f.apply.mock.calls.map(([input]) => input.name)).toEqual(['independent']);
    expect((await f.journal()).entries.some(([, entry]: [string, { input: { name: string } }]) => entry.input.name === f.input.name)).toBe(false);
  } finally { release(); await Promise.all([a, b]); }
});
it('progresses an already-due repair while another snapshot fsync is held', async () => {
  const f = await fixture(); let failing = true;
  f.apply.mockImplementation(async input => { if (input.name === 'independent' && failing) throw new Error('store pressure'); });
  expect(await f.owner.submit(f.independent)).toBe('pending'); failing = false; f.advance();
  let release!: () => void; io.hold = new Promise<void>(resolve => { release = resolve; });
  const a = f.owner.submit(f.input); await vi.waitFor(() => expect(io.calls).toBe(1));
  const due = f.owner.runDue(); let completed = false; void due.then(() => { completed = true; });
  try { await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1000 });
    expect(f.apply.mock.calls.map(([input]) => input.name)).toEqual(['independent', 'independent']);
  } finally { release(); await Promise.all([a, due]); }
});
it('copies mutable caller evidence before its first await', async () => {
  const f = await fixture();
  const input = { ...f.input, materialization: { ...f.input.materialization!, publicQuads: f.input.materialization!.publicQuads.map(q => ({ ...q })) } };
  const work = f.owner.submit(input);
  input.materialization.publicQuads[0].object = '"changed after submit"';
  await expect(work).resolves.toBe('repaired');
  expect(f.apply.mock.calls[0][0].materialization!.publicQuads).toEqual(f.input.materialization!.publicQuads);
});
it('owns preparation before synchronous stop, refuses later input and resumes its retained obligation', async () => {
  const f = await fixture(); let release!: () => void, stopping: Promise<void> | undefined, stopped = false;
  io.hold = new Promise<void>(resolve => { release = resolve; });
  io.onSync = () => { stopping = f.owner.stop().then(() => { stopped = true; }); };
  const a = f.owner.submit(f.input); await vi.waitFor(() => expect(stopping).toBeDefined());
  try { await expect(f.owner.submit(f.independent)).rejects.toThrow('stopped');
    await new Promise(resolve => setTimeout(resolve, 20)); expect(stopped).toBe(false); expect(f.apply).not.toHaveBeenCalled();
  } finally { io.onSync = undefined; release(); await a; await stopping; }
  expect((await f.journal()).entries).toHaveLength(1);
  f.owner.start(); f.advance(); await f.owner.runDue();
  expect(f.apply).toHaveBeenCalledOnce(); expect((await f.journal()).entries).toHaveLength(0);
});
it('bounds distinct physical preparations and pins references until admission', async () => {
  const f = await fixture(), snapshots = new NamedKaVmLifecycleSnapshots(f.dir);
  const commands = Array.from({ length: 6 }, (_, index) => normalizeLifecycleRepairInput(confirmedMaterializationFixture(false, undefined, String(index + 1)).input));
  let release!: () => void; io.hold = new Promise<void>(resolve => { release = resolve; });
  const work = commands.map(command => snapshots.prepare(command.materialization));
  try { await vi.waitFor(() => expect(io.calls).toBe(4));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(io.max).toBe(4); expect(io.calls).toBe(4);
  } finally { release(); }
  const leases = await Promise.all(work); expect(io.calls).toBe(6);
  await snapshots.retireUnreferenced(new Map());
  expect((await readdir(join(f.dir, 'named-ka-vm-lifecycle-snapshots'))).filter(name => name.endsWith('.json'))).toHaveLength(6);
  const command = commands[0], entries = new Map<string, LifecycleRepairEntry>([[lifecycleRepairKey(command), { input: command, preparedSnapshot: leases[0].snapshot ? leases[0] : undefined, attempts: 0, nextAttemptAt: 0 }]]);
  const wire = snapshots.encodePrepared(entries);
  for (const lease of leases) lease.release();
  await snapshots.retireUnreferenced(entries);
  expect((await new NamedKaVmLifecycleSnapshots(f.dir).decode(wire)).size).toBe(1);
  await snapshots.retireUnreferenced(new Map()); expect(await readdir(join(f.dir, 'named-ka-vm-lifecycle-snapshots'))).toHaveLength(0);
});
it('waits for physical retirement before reusing and journaling the same snapshot', async () => {
  const f = await fixture(), snapshots = new NamedKaVmLifecycleSnapshots(f.dir), command = normalizeLifecycleRepairInput(f.input);
  const entries = new Map<string, LifecycleRepairEntry>([[lifecycleRepairKey(command), { input: command, attempts: 0, nextAttemptAt: 0 }]]);
  await snapshots.encode(entries);
  let release!: () => void; io.deleteHold = new Promise<void>(resolve => { release = resolve; });
  const cleanup = snapshots.retireUnreferenced(new Map()); await vi.waitFor(() => expect(io.deleting).toBe(true));
  const work = snapshots.prepare(command.materialization); let done = false; void work.then(() => { done = true; });
  try { await new Promise(resolve => setTimeout(resolve, 20)); expect(done).toBe(false); }
  finally { release(); await cleanup; }
  const lease = await work;
  try {
    if (!lease.snapshot) throw new Error('Expected prepared snapshot');
    entries.get(lifecycleRepairKey(command))!.preparedSnapshot = lease;
    expect((await new NamedKaVmLifecycleSnapshots(f.dir).decode(snapshots.encodePrepared(entries))).size).toBe(1);
  }
  finally { lease.release(); }
});

it('reuses retained immutable evidence when an equivalent resubmission reorders metadata', async () => {
  const f = await fixture(); f.apply.mockRejectedValue(new Error('held store pressure'));
  expect(await f.owner.submit(f.input)).toBe('pending');
  const original = (await f.journal()).entries[0][1].input.materializationRef;
  const reordered = { ...f.input, materialization: { ...f.input.materialization!, metadataQuads: [...f.input.materialization!.metadataQuads].reverse() } };
  expect(await f.owner.submit(reordered)).toBe('pending');
  expect(io.calls).toBe(1); expect(f.apply).toHaveBeenCalledOnce();
  expect((await f.journal()).entries[0][1].input.materializationRef).toBe(original);
});

it('keeps uncertain-admission bytes until a replacement journal is durably committed', async () => {
  const f = await fixture(), replace = DurableReplaceableFile.prototype.replace;
  let failFirst = true, replacing = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(DurableReplaceableFile.prototype, 'replace').mockImplementation(async function (contents) {
    const path = (this as unknown as { path: string }).path;
    if (path.endsWith('named-ka-vm-lifecycle-repairs.json')) {
      if (failFirst) { failFirst = false; await replace.call(this, contents); throw new Error('uncertain admission'); }
      replacing = true; await held;
    }
    await replace.call(this, contents);
  });
  await expect(f.owner.submit(f.input)).rejects.toThrow('uncertain admission');
  const directory = join(f.dir, 'named-ka-vm-lifecycle-snapshots');
  expect(await readdir(directory)).toHaveLength(1); expect(f.apply).not.toHaveBeenCalled();
  const next = f.owner.submit(f.independent);
  try { await vi.waitFor(() => expect(replacing).toBe(true));
    expect((await f.journal()).entries[0][1].input.name).toBe(f.input.name);
    expect(await readdir(directory)).toHaveLength(1);
  } finally { release(); }
  expect(await next).toBe('repaired'); await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(0));
  expect(await f.owner.submit(f.input)).toBe('repaired');
  expect(io.calls).toBe(2); await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(0));
});

it('coalesces duplicate snapshots while their first physical fsync is still held', async () => {
  const f = await fixture(), snapshots = new NamedKaVmLifecycleSnapshots(f.dir);
  const commands = Array.from({ length: 3 }, () => normalizeLifecycleRepairInput(f.input));
  let release!: () => void; io.hold = new Promise<void>(resolve => { release = resolve; });
  const work = commands.map(command => snapshots.prepare(command.materialization));
  try { await vi.waitFor(() => expect(io.calls).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 30)); expect(io.calls).toBe(1); expect(io.active).toBe(1);
  } finally {
    release();
    for (const result of await Promise.allSettled(work)) if (result.status === 'fulfilled') result.value.release();
  }
  expect(io.calls).toBe(1);
});

it('readmits equivalent distinct snapshot objects after the retained repair retires during preparation', async () => {
  const f = await fixture(); f.apply.mockRejectedValueOnce(new Error('pressure'));
  expect(await f.owner.submit(f.input)).toBe('pending'); f.advance();
  const prepare = NamedKaVmLifecycleSnapshots.prototype.prepare;
  let preparing = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prepareSpy = vi.spyOn(NamedKaVmLifecycleSnapshots.prototype, 'prepare').mockImplementation(async function(snapshot) {
    const lease = await prepare.call(this, snapshot); preparing = true; await held; return lease;
  });
  const next = f.owner.submit(f.input), settled = next.then(value => value, error => error);
  try { await vi.waitFor(() => expect(preparing).toBe(true));
    await f.owner.runDue(); expect((await f.journal()).entries).toHaveLength(0);
  } finally { release(); }
  expect(await settled).toBe('repaired'); expect((await f.journal()).entries).toHaveLength(0);
  expect(prepareSpy).toHaveBeenCalledOnce();
});

it('allows independent admission and due retry during held cleanup and drains that cleanup on stop', async () => {
  const f = await fixture(); let failIndependent = true;
  f.apply.mockImplementation(async input => { if (input.name === 'independent' && failIndependent) throw new Error('pressure'); });
  expect(await f.owner.submit(f.independent)).toBe('pending');
  let release!: () => void; io.deleteHold = new Promise<void>(resolve => { release = resolve; });
  const a = f.owner.submit(f.input);
  await vi.waitFor(() => expect(io.deleting).toBe(true));
  failIndependent = false; f.advance();
  const c = f.owner.submit({ ...confirmedMaterializationFixture(false, undefined, '2').input, name: 'snapshot-independent' }), due = f.owner.runDue();
  let completed = false, stopped = false;
  const independent = Promise.all([c, due]).then(() => { completed = true; });
  let stopping: Promise<void> | undefined;
  try { await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1000 });
    expect(f.apply.mock.calls.filter(([input]) => input.name === 'independent')).toHaveLength(2);
    stopping = f.owner.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(stopped).toBe(false);
  } finally { release(); await Promise.all([a, independent, stopping]); }
});


it('compares equivalent frozen validated copies without an object-identity side table', () => {
  const command = normalizeLifecycleRepairInput(confirmedMaterializationFixture().input);
  const copy = Object.freeze({ ...command, materialization: Object.freeze({ ...command.materialization! }) });
  expect(reconcileLifecycleRepairEvidence({ input: command }, copy)).toMatchObject({ status: 'unchanged' });
  expect(Object.keys(lifecycleMaterializationWire(copy.materialization)).sort()).toEqual(['kaUal', 'metadataQuads', 'publicQuads']);
});


it('drains a held optional cleanup failure without failing shutdown or losing journal certainty', async () => {
  const f = await fixture(); let release!: () => void;
  io.deleteFailure = true; io.deleteHold = new Promise<void>(resolve => { release = resolve; });
  const a = f.owner.submit(f.input);
  await vi.waitFor(() => expect(io.deleting).toBe(true));
  expect(await a).toBe('repaired'); expect((await f.journal()).entries).toHaveLength(0);
  const stopped = f.owner.stop().then(() => true, error => error);
  release(); expect(await stopped).toBe(true);
  io.deleteFailure = false; f.owner.start();
  expect(await f.owner.submit(f.input)).toBe('repaired'); await f.owner.stop();
  expect(await readdir(join(f.dir, 'named-ka-vm-lifecycle-snapshots'))).toHaveLength(0);
});


it('carries exact owner-bound prepared evidence into encoding and requires fresh-owner adoption', async () => {
  const f = await fixture(), snapshots = new NamedKaVmLifecycleSnapshots(f.dir), fresh = new NamedKaVmLifecycleSnapshots(f.dir);
  const command = normalizeLifecycleRepairInput(f.input), prepared = await snapshots.prepare(command.materialization);
  if (!prepared.snapshot) throw new Error('Expected prepared snapshot');
  try {
    expect(prepared.snapshot).toBe(command.materialization); expect(Object.isFrozen(prepared)).toBe(true);
    const entries = new Map<string, LifecycleRepairEntry>([[lifecycleRepairKey(command), {
      input: command, preparedSnapshot: prepared, attempts: 0, nextAttemptAt: 0,
    }]]);
    const wire = snapshots.encodePrepared(entries);
    expect(wire.entries[0][1].input.materializationRef).toBe(prepared.reference);
    expect(wire.entries[0][1]).not.toHaveProperty('preparedSnapshot');
    await fresh.prepare();
    expect(() => fresh.encodePrepared(entries)).toThrow('not prepared by this owner');
    const adopted = await fresh.decode(wire), leases = await fresh.prepareEntries(adopted);
    try { expect(fresh.encodePrepared(adopted)).toEqual(wire); expect(io.calls).toBe(1); }
    finally { for (const lease of leases) lease.release(); }
  } finally { prepared.release(); }
});
