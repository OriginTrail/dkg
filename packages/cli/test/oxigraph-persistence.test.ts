import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { createManagedOxigraphPersistenceBarrierV1 } from '../src/daemon/oxigraph-persistence.js';

const DIRECTORY = resolve('/owned');
const wal = (name = '000001.log') => join(DIRECTORY, name);
const io = vi.hoisted(() => ({ names: [['000001.log']] as string[][], events: [] as string[],
  failure: null as { path: string; code: string } | null,
  onRead: null as (() => void) | null }));
vi.mock('node:fs/promises', () => ({
  readdir: async () => {
    io.onRead?.();
    const names = io.names.length > 1 ? io.names.shift()! : io.names[0]!;
    return names.map(name => ({ name, isFile: () => true }));
  },
  open: async (path: string, mode: string) => {
    io.events.push(`open:${path}:${mode}`);
    if (io.failure?.path === path) throw Object.assign(new Error('I/O failure'), { code: io.failure.code });
    return { sync: async () => { io.events.push(`sync:${path}`); },
      close: async () => { io.events.push(`close:${path}`); } };
  },
}));
beforeEach(() => { io.names = [['000001.log']]; io.events = []; io.failure = null; io.onRead = null; });

describe('managed Oxigraph post-acknowledgement persistence', () => {
  it('syncs existing WALs before the POSIX directory', async () => {
    io.names = [['000002.log', '000001.log', 'CURRENT', 'LOG']];
    await createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!();
    expect(io.events).toEqual([
      `open:${wal()}:r+`, `sync:${wal()}`, `close:${wal()}`,
      `open:${wal('000002.log')}:r+`, `sync:${wal('000002.log')}`, `close:${wal('000002.log')}`,
      `open:${DIRECTORY}:r`, `sync:${DIRECTORY}`, `close:${DIRECTORY}`,
    ]);
  });
  it('uses pinned RocksDB Windows file-sync policy without opening a directory', async () => {
    await createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'win32')!();
    expect(io.events).toEqual([`open:${wal()}:r+`, `sync:${wal()}`, `close:${wal()}`]);
  });
  it('retries a complete round after log rotation', async () => {
    io.names = [['000001.log'], ['000002.log'], ['000002.log'], ['000002.log']];
    await createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!();
    expect(io.events.filter(event => event.startsWith('sync:')))
      .toEqual([`sync:${wal()}`, `sync:${DIRECTORY}`, `sync:${wal('000002.log')}`, `sync:${DIRECTORY}`]);
  });
  it('retries an old log removed between listing and opening', async () => {
    io.names = [['000001.log'], ['000002.log']]; io.failure = { path: wal(), code: 'ENOENT' };
    await createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!();
    expect(io.events).toContain(`sync:${wal('000002.log')}`);
  });
  it('bounds a continuously rotating WAL instead of certifying completion', async () => {
    io.names = Array.from({ length: 6 }, (_, i) => [`00000${i + 1}.log`]);
    await expect(createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!())
      .rejects.toThrow('retain repair evidence');
    expect(io.events.filter(event => event === `sync:${DIRECTORY}`)).toHaveLength(3);
  });
  it.each([wal(), DIRECTORY])('propagates persistence failure for %s', async path => {
    io.failure = { path, code: 'EIO' };
    await expect(createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!())
      .rejects.toMatchObject({ code: 'EIO' });
  });
  it('refuses a location with no active WAL', async () => {
    io.names = [[]];
    await expect(createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!()).rejects.toThrow('active WAL');
    expect(io.events).toEqual([]);
  });
  it('does not certify unreviewed engine versions', () => {
    expect(createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.9')).toBeUndefined();
  });
  it('honors cancellation during the final enumeration', async () => {
    const controller = new AbortController(), reason = new Error('cancel persistence');
    let calls = 0; io.onRead = () => { if (++calls === 2) controller.abort(reason); };
    await expect(createManagedOxigraphPersistenceBarrierV1(DIRECTORY, '0.5.8', 'linux')!({ signal: controller.signal }))
      .rejects.toBe(reason);
  });
});
