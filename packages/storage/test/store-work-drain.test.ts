import { expect, it } from 'vitest';
import { StoreWorkDrain } from '../src/store-work-drain.js';

it('drains and gates each reusable generation independently', async () => {
  const owner = new StoreWorkDrain('test owner is closing');
  let finalized = 0;
  for (let generation = 0; generation < 2; generation += 1) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const accepted = owner.run(() => held).then(() => 'ack', () => 'rejected');
    const closing = owner.close(async () => { finalized += 1; });
    try {
      expect(owner.close(async () => { throw new Error('duplicate finalizer'); })).toBe(closing);
      await expect(owner.run(async () => {})).rejects.toThrow('closing');
      expect(finalized).toBe(generation);
    } finally { release(); await closing; }
    expect(await accepted).toBe('ack');
    expect(finalized).toBe(generation + 1);
  }
});

it('keeps admission closed throughout finalization and after a failed finalizer', async () => {
  const owner = new StoreWorkDrain('test owner is closing');
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const closing = owner.close(async () => { enter(); await held; throw new Error('final snapshot EIO'); });
  try {
    await entered;
    await expect(owner.run(async () => {})).rejects.toThrow('closing');
  } finally { release(); await expect(closing).rejects.toThrow('snapshot EIO'); }
  await expect(owner.run(async () => {})).rejects.toThrow('closing');
});

it('waits for accepted work and cleanup after an early shutdown failure', async () => {
  const owner = new StoreWorkDrain('test owner is closing');
  let release!: () => void, begin!: () => void, cleaned = false, settled = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const begun = new Promise<void>(resolve => { begin = resolve; });
  const accepted = owner.run(() => held);
  const closing = owner.close(async () => { cleaned = true; }, async () => { begin(); throw new Error('early shutdown EIO'); });
  const observed = closing.then(() => { settled = true; }, error => { settled = true; return error.message; });
  try {
    await begun; await new Promise<void>(resolve => setImmediate(resolve));
    expect({ cleaned, settled }).toEqual({ cleaned: false, settled: false });
    expect(owner.close(async () => { throw new Error('duplicate cleanup'); })).toBe(closing);
    await expect(owner.run(async () => {})).rejects.toThrow('closing');
  } finally { release(); await Promise.allSettled([accepted, closing]); }
  await expect(observed).resolves.toBe('early shutdown EIO');
  expect(cleaned).toBe(true);
  await expect(owner.run(async () => {})).rejects.toThrow('closing');
});
