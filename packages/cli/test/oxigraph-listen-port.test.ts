import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  findListenOwnerPid,
  procNetLocalPortHex,
  type ListenOwnerCommandRunner,
} from '../src/daemon/oxigraph-listen-port.js';

describe('procNetLocalPortHex', () => {
  it('formats the local port in big-endian hex for /proc/net/tcp matching', () => {
    // The /proc/net/tcp port is NOT byte-swapped (only the IPv4 address is).
    expect(procNetLocalPortHex(7878)).toBe('1EC6');
    expect(procNetLocalPortHex(8080)).toBe('1F90');
  });
});

describe('Windows listener ownership', () => {
  it('accepts the descendant that owns the configured listening port', async () => {
    const calls: string[] = [];
    const runCommand: ListenOwnerCommandRunner = async (command) => {
      calls.push(command);
      if (command === 'powershell.exe') {
        return { stdout: '100 1\n101 100\n102 101\n900 1\n' };
      }
      return {
        stdout:
          '  TCP    127.0.0.1:7878    0.0.0.0:0    LISTENING    102\n' +
          '  TCP    127.0.0.1:7879    0.0.0.0:0    LISTENING    900\n',
      };
    };
    const child = {
      pid: 100,
      exitCode: null,
      signalCode: null,
    } as ChildProcess;

    await expect(findListenOwnerPid(
      child,
      7878,
      '127.0.0.1',
      'process-tree',
      { platform: 'win32', runCommand },
    )).resolves.toBe(102);
    expect(calls).toEqual(['powershell.exe', 'netstat']);
  });

  it('rejects an unrelated Windows listener on the configured port', async () => {
    const runCommand: ListenOwnerCommandRunner = async (command) => command === 'powershell.exe'
      ? { stdout: '100 1\n101 100\n' }
      : { stdout: '  TCP    127.0.0.1:7878    0.0.0.0:0    LISTENING    900\n' };
    const child = {
      pid: 100,
      exitCode: null,
      signalCode: null,
    } as ChildProcess;

    await expect(findListenOwnerPid(
      child,
      7878,
      '127.0.0.1',
      'process-tree',
      { platform: 'win32', runCommand },
    )).resolves.toBeNull();
  });
});
