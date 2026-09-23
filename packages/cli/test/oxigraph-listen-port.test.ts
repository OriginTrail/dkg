import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  findListenOwnerPid,
  linuxProcessTree,
  procNetLocalPortHex,
  psProcessTree,
} from '../src/daemon/oxigraph-listen-port.js';

describe('procNetLocalPortHex', () => {
  it('formats the local port in big-endian hex for /proc/net/tcp matching', () => {
    // The /proc/net/tcp port is NOT byte-swapped (only the IPv4 address is).
    expect(procNetLocalPortHex(7878)).toBe('1EC6');
    expect(procNetLocalPortHex(8080)).toBe('1F90');
  });
});

const LISTENER_SOURCE =
  'const s = require("node:net").createServer(); '
  + 's.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: s.address().port })))';

async function listening(child: ChildProcess): Promise<{ pid: number; port: number }> {
  const [chunk] = await once(child.stdout!, 'data');
  return JSON.parse(String(chunk).trim());
}

describe('findListenOwnerPid (real processes)', () => {
  it('attributes a wrapped listener to its wrapper only when the process tree is allowed', async () => {
    // The shape of the parent watchdog: the spawned child is a wrapper and
    // Oxigraph, the listener, is the wrapper's child.
    const wrapper = spawn(process.execPath, [
      '-e',
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LISTENER_SOURCE)}], { stdio: 'inherit' });`,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    // An unrelated local listener, outside the wrapper's tree.
    const foreign = spawn(process.execPath, ['-e', LISTENER_SOURCE], { stdio: ['ignore', 'pipe', 'inherit'] });
    let wrapped: { pid: number; port: number } | undefined;
    try {
      wrapped = await listening(wrapper);
      const unrelated = await listening(foreign);

      expect(await findListenOwnerPid(wrapper, wrapped.port, '127.0.0.1', 'process-tree')).toBe(wrapped.pid);
      expect(await findListenOwnerPid(wrapper, wrapped.port, '127.0.0.1', 'child-only')).toBeNull();
      expect(await findListenOwnerPid(wrapper, unrelated.port, '127.0.0.1', 'process-tree')).toBeNull();

      // Both tree walkers, wherever the host supports them.
      const walkers: Array<[string, (pid: number) => Promise<Set<number>>]> = [['ps', psProcessTree]];
      if (existsSync('/proc/self/task')) walkers.push(['procfs', linuxProcessTree]);
      for (const [name, processTree] of walkers) {
        const tree = await processTree(wrapper.pid!);
        expect(tree.has(wrapped.pid), name).toBe(true);
        expect(tree.has(unrelated.pid), name).toBe(false);
      }
    } finally {
      wrapper.kill('SIGKILL');
      foreign.kill('SIGKILL');
      if (wrapped) { try { process.kill(wrapped.pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });
});
