// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { platform, userInfo } from 'node:os';
import type { McpConfigSelection } from '../src/mcp-client-registry.js';
import { clientMcpEntry } from '../src/mcp-launch-command.js';
import { windowsSystemRoot } from '../src/mcp-windows-system-root.js';
import { forwardedWslEnvironment } from '../src/mcp-wsl-environment.js';

const saved = { distro: process.env.WSL_DISTRO_NAME, root: process.env.SystemRoot, upper: process.env.SYSTEMROOT, wslenv: process.env.WSLENV };
afterEach(() => {
  for (const [key, value] of Object.entries({ WSL_DISTRO_NAME: saved.distro, SystemRoot: saved.root, SYSTEMROOT: saved.upper, WSLENV: saved.wslenv })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const selection = (...locations: Array<'native' | 'windows-wsl'>) => ({
  aliases: locations.map(location => ({ location })),
}) as McpConfigSelection;
const canonical = { command: '/home/alice/node 22/bin/node', args: ['/home/alice/dkg package/cli.js', 'mcp', 'serve'],
  env: { DKG_HOME: '/home/alice/DKG data/$(touch injected); literal' } };

describe('MCP client launch boundary', () => {
// test-disable-allow: D1 #433 -- owner=cli lane=cli-unit-linux expires=2026-11-08 POSIX env execution runs in required Linux unit shards; Windows cannot execute /usr/bin/env.
  it.skipIf(platform() === 'win32')('executes the Linux env payload with literal spaces and metacharacters', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    const entry = clientMcpEntry({ ...canonical, command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({home:process.env.DKG_HOME,args:process.argv.slice(1)}))', 'a b;$HOME'] },
    selection('windows-wsl'), 'wsl');
    const execIndex = entry.args.indexOf('--exec') + 1;
    expect(entry.args[execIndex]).toBe('/usr/bin/env');
    const output = execFileSync('/usr/bin/env', entry.args.slice(execIndex + 1), { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({ home: canonical.env.DKG_HOME, args: ['a b;$HOME'] });
  });
  it.each(['linux', 'windows', 'posix'] as const)('leaves native %s registrations unchanged', runtime => {
    expect(clientMcpEntry(canonical, selection('native'), runtime)).toBe(canonical);
  });
  it('leaves Linux-side clients unchanged inside WSL', () => {
    expect(clientMcpEntry(canonical, selection('native'), 'wsl')).toBe(canonical);
  });
  it('pins the distro, OS user and absolute runtime without shell interpolation', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu DKG';
    process.env.SystemRoot = 'D:\\Windows';
    process.env.WSLENV = 'USER_SETTING/pl';
    expect(clientMcpEntry(canonical, selection('windows-wsl'), 'wsl')).toEqual({
      command: 'D:\\Windows\\System32\\wsl.exe',
      args: ['--distribution', 'Ubuntu DKG', '--user', userInfo().username, '--exec', '/usr/bin/env', '--',
        `DKG_HOME=${canonical.env.DKG_HOME}`, canonical.command, ...canonical.args],
      env: canonical.env,
      environmentTransfer: { kind: 'windows-wsl', inherited: 'USER_SETTING/pl' },
    });
  });
  it('refuses a missing distro rather than relying on a changeable Windows default', () => {
    delete process.env.WSL_DISTRO_NAME;
    expect(() => clientMcpEntry(canonical, selection('windows-wsl'), 'wsl')).toThrow('WSL_DISTRO_NAME');
  });
  it('refuses a shared physical config that would need two incompatible commands', () => {
    expect(() => clientMcpEntry(canonical, selection('native', 'windows-wsl'), 'wsl')).toThrow('separate config files');
  });
  it('refuses a relative Windows executable root', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'; process.env.SystemRoot = 'Windows';
    expect(() => clientMcpEntry(canonical, selection('windows-wsl'), 'wsl')).toThrow('absolute Windows SystemRoot');
  });

  it('shares root precedence and default between Windows executables', () => {
    delete process.env.SystemRoot; delete process.env.SYSTEMROOT;
    expect(windowsSystemRoot()).toBe('C:\\Windows');
    process.env.SYSTEMROOT = 'D:\\Windows';
    expect(windowsSystemRoot()).toBe('D:\\Windows');
    process.env.SystemRoot = 'E:/Windows';
    expect(windowsSystemRoot()).toBe('E:/Windows');
  });
  it.each(['.', 'Windows', 'C:Windows', '\\Windows', 'C:\\Windows\\..\\untrusted'])('rejects invalid shared SystemRoot %s', root => {
    process.env.SystemRoot = root;
    expect(windowsSystemRoot).toThrow('absolute Windows SystemRoot');
  });
  it('keeps WSLENV names case-sensitive and compatible combined flags', () => {
    expect(forwardedWslEnvironment({ DKG_PROJECT: 'literal', CUSTOM: 'literal', WSLENV: 'dkg_project/w:DKG_PROJECT/ulw:CUSTOM/plw:OTHER/w' }, ''))
      .toBe('dkg_project/w:DKG_PROJECT/ul:CUSTOM/pl:OTHER/w');
  });
  it.each(['BAD:NAME', 'BAD/NAME', 'BAD=NAME', 'BAD\nNAME'])('rejects unrepresentable WSLENV names without including values (%s)', name => {
    expect(() => forwardedWslEnvironment({ [name]: 'private-fixture-value' }, '')).toThrow('MCP environment variable names');
  });

});
