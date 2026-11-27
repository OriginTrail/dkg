import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectClients, selectMcpClientTargets } from '../src/mcp-client-registry.js';
import { applyRegistrationEditToBody } from '../src/mcp-config-document.js';
import { mcpUninstallAction } from '../src/mcp-uninstall.js';

const fixture = vi.hoisted(() => ({ home: '', platform: 'win32', runtime: 'windows' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.home, platform: () => fixture.platform }));
vi.mock('../src/mcp-runtime.js', () => ({ detectMcpRuntime: () => fixture.runtime }));
let root: string;
let local: string;
let roaming: string;
const config = (name: string) => join(local, 'Claude-Data', name, 'claude_desktop_config.json');
function write(file: string, value: unknown = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-relocated-'));
  fixture.home = join(root, 'user');
  fixture.platform = 'win32';
  fixture.runtime = 'windows';
  local = join(root, 'Local');
  roaming = join(root, 'Roaming');
  vi.stubEnv('LOCALAPPDATA', local);
  vi.stubEnv('APPDATA', roaming);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const desktop = () => detectClients().filter((target) => target.id === 'claude-desktop');

describe('Claude Desktop relocated Windows user data', () => {
  it('discovers an existing relocated config and preserves app settings when registering DKG', () => {
    const original = { preferences: { theme: 'dark' }, coworkUserFilesPath: 'keep', userDataOutsidePackageAnswer: true, mcpServers: { other: { command: 'keep' } } };
    const targetPath = config('claude_profile123');
    write(targetPath, original);
    const targets = desktop();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ configPath: targetPath, location: 'native' });
    const selection = selectMcpClientTargets(targets)[0];
    const source = selection.file.readSource();
    const edited = applyRegistrationEditToBody(JSON.parse(readFileSync(targetPath, 'utf8')), {
      kind: 'upsert', registration: { command: 'node', args: ['dkg', 'mcp', 'serve'], env: { DKG_HOME: join(root, 'node') } },
    }, selection.file.shape.serverContainer);
    // Detection models Windows paths on any host; persistence uses this test host's real strategy.
    fixture.runtime = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'posix';
    selection.file.write(JSON.stringify(edited), source);
    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toMatchObject(original);
    expect(JSON.parse(readFileSync(targetPath, 'utf8')).mcpServers.dkg.env.DKG_HOME).toBe(join(root, 'node'));
  });

  it('chooses one latest existing config over stale classic and other relocated profiles', () => {
    const classic = join(roaming, 'Claude', 'claude_desktop_config.json');
    write(classic); write(config('claude_old')); write(config('claude_active'));
    utimesSync(classic, 10, 10); utimesSync(config('claude_old'), 20, 20); utimesSync(config('claude_active'), 30, 30);
    expect(desktop().map((target) => target.configPath)).toEqual([config('claude_active')]);
  });

  it.each((['native', 'windows-wsl'] as const).flatMap(location => [false, true].map(fractional => ({ location, fractional }))))(
    'removes older registrations without changing the preferred profile ($location, fractional: $fractional)', async ({ location, fractional }) => {
    const classic = join(roaming, 'Claude', 'claude_desktop_config.json');
    const older = config('claude_old');
    const latest = config('claude_latest');
    const preserved = { preferences: { theme: 'dark' }, coworkUserFilesPath: 'keep', mcpServers: { other: { command: 'keep' } } };
    for (const file of [classic, older]) write(file, { ...preserved, mcpServers: { ...preserved.mcpServers, dkg: { command: 'dkg' } } });
    write(latest, preserved);
    const times = fractional ? [10, 1_700_000_000.0009, 1_700_000_000.00095] : [10, 20, 30];
    for (const [index, file] of [classic, older, latest].entries()) utimesSync(file, times[index], times[index]);
    const before = [classic, older, latest].map((file) => statSync(file).mtimeMs);
    if (location === 'windows-wsl') { fixture.platform = 'linux'; fixture.runtime = 'wsl'; }
    const windows = { APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: join(root, 'windows-user') };
    const resolver = (key: string) => windows[key as keyof typeof windows] ?? null;
    expect(detectClients({ resolveWslWindowsEnvPath: resolver }).filter((target) => target.id === 'claude-desktop').map((target) => target.configPath)).toEqual([latest]);
    const untouched = readFileSync(latest, 'utf8');
    await mcpUninstallAction({ yes: true, client: `claude-desktop:${location}` }, {
      detectClients: (options = {}) => {
        const targets = detectClients({ ...options, resolveWslWindowsEnvPath: resolver });
        // Discovery models the selected platform; persistence writes actual host temporary files.
        fixture.runtime = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'posix';
        return targets;
      },
      log: () => {},
    });
    for (const file of [classic, older]) expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(preserved);
    expect(readFileSync(latest, 'utf8')).toBe(untouched);
    // Cleanup must not make stale profiles appear to be the active setup destination.
    // Node's timestamp API rounds to microseconds; preserve sub-millisecond ordering.
    [classic, older, latest].forEach((file, index) => expect(statSync(file).mtimeMs).toBeCloseTo(before[index], 2));
    fixture.runtime = location === 'windows-wsl' ? 'wsl' : 'windows';
    expect(detectClients({ resolveWslWindowsEnvPath: resolver }).filter((target) => target.id === 'claude-desktop').map((target) => target.configPath)).toEqual([latest]);
  });

  it('keeps classic installs and permits a fresh relocated profile directory', () => {
    write(join(roaming, 'Claude', 'claude_desktop_config.json'));
    expect(desktop()[0].configPath).toBe(join(roaming, 'Claude', 'claude_desktop_config.json'));
    rmSync(roaming, { recursive: true });
    mkdirSync(dirname(config('claude_fresh')), { recursive: true });
    expect(desktop()[0].configPath).toBe(config('claude_fresh'));
  });

  it('uses LOCALAPPDATA from the Windows environment when detecting through WSL', () => {
    fixture.platform = 'linux'; fixture.runtime = 'wsl';
    write(config('claude_wsl'));
    const windows = { APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: join(root, 'windows-user') };
    const targets = detectClients({ resolveWslWindowsEnvPath: (key) => windows[key as keyof typeof windows] ?? null });
    expect(targets.filter((target) => target.id === 'claude-desktop')).toMatchObject([{ configPath: config('claude_wsl'), location: 'windows-wsl' }]);
  });

  it('explains both checked locations when another client is found but Desktop is absent', () => {
    write(join(fixture.home, '.claude.json'));
    const report = vi.fn();
    expect(detectClients({ reportMissing: report }).some((target) => target.id === 'claude-code')).toBe(true);
    expect(report).toHaveBeenCalledWith({ id: 'claude-desktop', name: 'Claude Desktop', location: 'native',
      checkedPaths: [join(roaming, 'Claude', 'claude_desktop_config.json'), join(local, 'Claude-Data', 'claude_*', 'claude_desktop_config.json')] });
  });

  it('does not scan relocated Windows data for native macOS clients', () => {
    fixture.platform = 'darwin'; fixture.runtime = 'posix';
    write(config('claude_wrong'));
    const native = join(fixture.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    write(native);
    expect(desktop().map((target) => target.configPath)).toEqual([native]);
  });
});
