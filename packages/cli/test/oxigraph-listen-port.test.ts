import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { findListenOwnerPid, procNetLocalPortHex, windowsTcpOwnerPid } from '../src/daemon/oxigraph-listen-port.js';
import {
  linuxProcessTree,
  procHasFdTarget,
  processTreeWalker,
  psProcessTree,
  type ProcessTreeWalker,
} from '../src/daemon/process-probe.js';

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
      // Off loopback, only a child-only caller may take the child on trust.
      expect(await findListenOwnerPid(wrapper, wrapped.port, '0.0.0.0', 'process-tree')).toBe(wrapped.pid);
      expect(await findListenOwnerPid(wrapper, wrapped.port, '0.0.0.0', 'child-only')).toBe(wrapper.pid);

      // Each tree walker the host supports, through the same ownership check
      // (the `ps` walker is what macOS selects; CI runs it on Linux here).
      const walkers: Array<[string, ProcessTreeWalker]> = [['ps', psProcessTree]];
      if (existsSync('/proc/self/task')) walkers.push(['procfs', linuxProcessTree]);
      for (const [name, processTree] of walkers) {
        const tree = await processTree(wrapper.pid!);
        expect(tree.has(wrapped.pid), name).toBe(true);
        expect(tree.has(unrelated.pid), name).toBe(false);
        expect(
          await findListenOwnerPid(wrapper, wrapped.port, '127.0.0.1', 'process-tree', processTree),
          name,
        ).toBe(wrapped.pid);
        expect(
          await findListenOwnerPid(wrapper, unrelated.port, '127.0.0.1', 'process-tree', processTree),
          name,
        ).toBeNull();
      }
    } finally {
      wrapper.kill('SIGKILL');
      foreign.kill('SIGKILL');
      if (wrapped) { try { process.kill(wrapped.pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });
});

describe('processTreeWalker', () => {
  it('walks /proc on Linux and one ps snapshot on other Unix hosts', () => {
    expect(processTreeWalker('linux')).toBe(linuxProcessTree);
    expect(processTreeWalker('darwin')).toBe(psProcessTree);
    expect(processTreeWalker('freebsd')).toBe(psProcessTree);
  });
});

describe('procHasFdTarget', () => {
  it('stops at the first matching descriptor and treats an unreadable process as holding none', async () => {
    if (!existsSync('/proc/self/fd')) {
      // Without /proc every process reads as holding nothing.
      await expect(procHasFdTarget(process.pid, () => true)).resolves.toBe(false);
      return;
    }
    let seen = 0;
    await expect(procHasFdTarget(process.pid, () => { seen += 1; return true; })).resolves.toBe(true);
    expect(seen).toBe(1);
    await expect(procHasFdTarget(process.pid, () => false)).resolves.toBe(false);
    await expect(procHasFdTarget(2 ** 22 + 7, () => true)).resolves.toBe(false);
  });
});


describe('Windows TCP service ownership', () => {
  it.each(['LISTENING', 'ESTABLISHED'])('accepts the child local endpoint in %s state', state => {
    expect(windowsTcpOwnerPid(`  TCP    127.0.0.1:7878    127.0.0.1:59001    ${state}    24336\r\n`, 24336, 7878)).toBe(24336);
  });
  it('accepts an IPv6 local endpoint with the exact target port', () => {
    expect(windowsTcpOwnerPid(' TCP [::1]:7878 [::1]:59001 ESTABLISHED 24336', 24336, 7878)).toBe(24336);
  });
  it.each([
    'TCP 127.0.0.1:59001 127.0.0.1:7878 ESTABLISHED 24336',
    'TCP 127.0.0.1:59001 127.0.0.1:7878 LISTENING 24336',
    'TCP 127.0.0.1:78780 0.0.0.0:0 LISTENING 24336',
    'TCP 127.0.0.1:7878 0.0.0.0:0 LISTENING 99',
    'TCP 127.0.0.1:7878 127.0.0.1:59001 TIME_WAIT 24336',
    'TCP 127.0.0.1:7878 127.0.0.1:59001 CLOSE_WAIT 24336',
    'UDP 127.0.0.1:7878 *:* ESTABLISHED 24336',
    'TCP 127.0.0.1:7878 LISTENING 24336',
  ])('rejects non-serving or unrelated rows: %s', row => {
    expect(windowsTcpOwnerPid(row, 24336, 7878)).toBeNull();
  });
  it('ignores headers and unrelated rows before the matching server row', () => {
    expect(windowsTcpOwnerPid([
      'Active Connections', 'Proto Local Address Foreign Address State PID',
      'TCP 127.0.0.1:7878 0.0.0.0:0 LISTENING 99',
      'TCP 127.0.0.1:7878 127.0.0.1:59001 ESTABLISHED 24336',
    ].join('\n'), 24336, 7878)).toBe(24336);
  });
});
