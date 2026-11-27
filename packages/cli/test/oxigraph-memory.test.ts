import { describe, it, expect } from 'vitest';
import {
  readCgroupOomSnapshot,
  readCgroupOomKill,
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

describe('oxigraph-memory OOM reader (best-effort, non-throwing)', () => {
  it('readCgroupOomSnapshot returns dir + oom_kill on Linux cgroup-v2', () => {
    const io = makeIo({
      '/proc/42/cgroup': '0::/system.slice/dkg-v9-node.service\n',
      [`${CG}/memory.events`]: 'low 0\nhigh 11239\nmax 3\noom 1\noom_kill 2\n',
    });
    expect(readCgroupOomSnapshot(42, io)).toEqual({ dir: CG, oomKill: 2 });
  });

  it('readCgroupOomSnapshot returns null on non-Linux / bad pid / cgroup-v1', () => {
    const linux = makeIo({
      '/proc/42/cgroup': '0::/x\n',
      '/sys/fs/cgroup/x/memory.events': 'oom_kill 0\n',
    });
    expect(readCgroupOomSnapshot(42, { ...linux, platform: 'darwin' })).toBeNull();
    expect(readCgroupOomSnapshot(0, linux)).toBeNull();
    expect(readCgroupOomSnapshot(1.5, linux)).toBeNull();
    // cgroup-v1 (no `0::` entry)
    expect(
      readCgroupOomSnapshot(9, makeIo({ '/proc/9/cgroup': '12:memory:/system.slice/foo\n' })),
    ).toBeNull();
  });

  it('readCgroupOomSnapshot returns null when memory.events is unreadable', () => {
    expect(readCgroupOomSnapshot(42, makeIo({ '/proc/42/cgroup': '0::/x\n' }))).toBeNull();
  });

  it('readCgroupOomKill re-reads oom_kill from a captured dir (exit-time path)', () => {
    const io = makeIo({ [`${CG}/memory.events`]: 'high 5\nmax 1\noom_kill 3\n' });
    expect(readCgroupOomKill(CG, io)).toBe(3);
    expect(readCgroupOomKill('', io)).toBeNull();
    expect(readCgroupOomKill(CG, makeIo({}, 'darwin'))).toBeNull();
    expect(readCgroupOomKill('/missing', io)).toBeNull();
  });
});
