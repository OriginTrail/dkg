import { describe, it, expect } from 'vitest';
import {
  readOxigraphMemoryStats,
  readCgroupEvents,
  type MemoryReaderIo,
} from '../src/daemon/oxigraph-memory.js';

function makeIo(files: Record<string, string>, platform: string = 'linux'): MemoryReaderIo {
  return {
    platform,
    readTextSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      throw new Error(`ENOENT: no such file ${p}`);
    },
  };
}

const CG = '/sys/fs/cgroup/system.slice/dkg-v9-node.service';

describe('oxigraph-memory reader (best-effort, non-throwing)', () => {
  it('returns null on non-Linux', () => {
    expect(readOxigraphMemoryStats(123, makeIo({}, 'darwin'))).toBeNull();
  });

  it('returns null for a non-positive/invalid pid', () => {
    expect(readOxigraphMemoryStats(0, makeIo({}))).toBeNull();
    expect(readOxigraphMemoryStats(-1, makeIo({}))).toBeNull();
    expect(readOxigraphMemoryStats(1.5, makeIo({}))).toBeNull();
  });

  it('parses RSS + cgroup-v2 accounting including oom_kill', () => {
    const io = makeIo({
      '/proc/42/status': 'Name:\toxigraph\nVmRSS:\t 3145728 kB\nThreads:\t8\n',
      '/proc/42/cgroup': '0::/system.slice/dkg-v9-node.service\n',
      [`${CG}/memory.current`]: '4000000000\n',
      [`${CG}/memory.max`]: '5368709120\n',
      [`${CG}/memory.events`]: 'low 0\nhigh 11239\nmax 3\noom 1\noom_kill 2\n',
    });
    const stats = readOxigraphMemoryStats(42, io);
    expect(stats).not.toBeNull();
    expect(stats!.rssBytes).toBe(3145728 * 1024);
    expect(stats!.cgroup).toMatchObject({
      dir: CG,
      currentBytes: 4000000000,
      maxBytes: 5368709120,
      events: { high: 11239, max: 3, oomKill: 2 },
    });
  });

  it('reports maxBytes null when the cgroup is uncapped ("max")', () => {
    const io = makeIo({
      '/proc/7/status': 'VmRSS:\t 1024 kB\n',
      '/proc/7/cgroup': '0::/foo\n',
      '/sys/fs/cgroup/foo/memory.current': '100\n',
      '/sys/fs/cgroup/foo/memory.max': 'max\n',
      '/sys/fs/cgroup/foo/memory.events': 'high 0\nmax 0\noom_kill 0\n',
    });
    expect(readOxigraphMemoryStats(7, io)!.cgroup!.maxBytes).toBeNull();
  });

  it('returns cgroup null on cgroup-v1 (no 0:: entry) but still reports RSS', () => {
    const io = makeIo({
      '/proc/9/status': 'VmRSS:\t 2048 kB\n',
      '/proc/9/cgroup': '12:memory:/system.slice/foo\n11:cpu:/system.slice/foo\n',
    });
    const stats = readOxigraphMemoryStats(9, io);
    expect(stats).not.toBeNull();
    expect(stats!.rssBytes).toBe(2048 * 1024);
    expect(stats!.cgroup).toBeNull();
  });

  it('readCgroupEvents reads events from a captured dir (the exit-time path)', () => {
    const io = makeIo({ '/sys/fs/cgroup/x/memory.events': 'high 5\nmax 1\noom_kill 3\n' });
    expect(readCgroupEvents('/sys/fs/cgroup/x', io)).toEqual({ high: 5, max: 1, oomKill: 3 });
    expect(readCgroupEvents('', io)).toBeNull();
    expect(readCgroupEvents('/sys/fs/cgroup/x', makeIo({}, 'darwin'))).toBeNull();
    expect(readCgroupEvents('/missing', io)).toBeNull();
  });
});
