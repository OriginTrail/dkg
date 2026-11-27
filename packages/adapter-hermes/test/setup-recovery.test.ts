import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDkgNodeConfig, fundWalletsBestEffort, startDaemon } from '@origintrail-official/dkg-core';
import { disconnectHermesProfile, planHermesSetup, resolveHermesProfile, restoreHermesProfile, runDisconnect, runDoctor, runHermesSetup, runReconnect, runStatus, runUninstall, runVerify, setupHermesProfile, uninstallHermesProfile, verifyHermesProfile } from '../src/setup.js';

const fault = vi.hoisted(() => ({ read: new Map<string, unknown>(), write: new Map<string, unknown>(), chmod: false, noPlugin: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      for (const [path, error] of fault.read) { if (String(args[0]).endsWith(path)) throw error; }
      return real.readFileSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (fault.write.has(String(args[0]))) throw fault.write.get(String(args[0]));
      return real.writeFileSync(...args);
    },
    existsSync: (path: Parameters<typeof real.existsSync>[0]) => fault.noPlugin && String(path).endsWith('hermes-plugin/__init__.py') ? false : real.existsSync(path),
    chmodSync: (...args: Parameters<typeof real.chmodSync>) => {
      if (fault.chmod) throw new Error('POSIX modes unavailable');
      return real.chmodSync(...args);
    },
  };
});
vi.mock('@origintrail-official/dkg-core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@origintrail-official/dkg-core')>(),
  startDaemon: vi.fn(async () => {}), fundWalletsBestEffort: vi.fn(async () => {}), ensureDkgNodeConfig: vi.fn(),
}));

let root: string;
let home: string;
let node: string;
let fetchMock: ReturnType<typeof vi.fn>;
const begin = '# BEGIN DKG ADAPTER HERMES MANAGED';
const end = '# END DKG ADAPTER HERMES MANAGED';
function put(path: string, value: unknown) { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); }
function config(value: string) { put(join(home, 'config.yaml'), value); }
function setup(options = {}) { return setupHermesProfile({ hermesHome: home, ...options }); }
function stateFile() { return join(home, '.dkg-adapter-hermes/setup-state.json'); }
function state() { return JSON.parse(readFileSync(stateFile(), 'utf8')); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hermes-recovery-'));
  home = join(root, 'profile'); node = join(root, 'node');
  mkdirSync(home); mkdirSync(node);
  vi.stubEnv('DKG_HOME', node); vi.stubEnv('HERMES_HOME', home);
  vi.stubEnv('DKG_API_TOKEN', ''); vi.stubEnv('DKG_AUTH_TOKEN', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(startDaemon).mockReset().mockResolvedValue(undefined);
  vi.mocked(fundWalletsBestEffort).mockReset().mockResolvedValue(undefined);
  vi.mocked(ensureDkgNodeConfig).mockReset();
});
afterEach(() => {
  fault.read.clear(); fault.write.clear(); fault.chmod = false; fault.noPlugin = false;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('profile verification and ownership', () => {
  it.each(['../other', 'a/b', 'a\\b'])('rejects profile traversal %s', (profileName) => {
    expect(() => resolveHermesProfile({ profileName, hermesHome: home })).toThrow('path separators');
  });
  it('reports missing, malformed and foreign setup state without overwriting it', async () => {
    expect(verifyHermesProfile({ hermesHome: join(root, 'absent') }).errors.join('\n')).toContain('directory does not exist');
    expect(verifyHermesProfile({ hermesHome: home }).errors.join('\n')).toContain('setup state not found');
    mkdirSync(join(home, '.dkg-adapter-hermes'));
    put(stateFile(), '{bad json');
    expect(verifyHermesProfile({ hermesHome: home }).ok).toBe(false);
    put(stateFile(), { managedBy: 'someone-else', profile: { memoryMode: 'provider' } });
    put(join(home, 'dkg.json'), '{bad json');
    const result = verifyHermesProfile({ hermesHome: home });
    expect(result.errors.join('\n')).toContain('not owned by this adapter');
    expect(result.errors.join('\n')).toContain('not ownership-marked');
    expect(() => setup()).toThrow('non-managed Hermes DKG config');
    await expect(runVerify({ hermesHome: home })).rejects.toThrow('not owned');
    await expect(runDoctor({ hermesHome: home })).rejects.toThrow('not owned');
    await runStatus({ hermesHome: home });
    expect(readFileSync(join(home, 'dkg.json'), 'utf8')).toBe('{bad json');
  });
  it('requires the effective provider, not just a managed marker', () => {
    setup();
    config(`${begin}\nmemory:\n  provider: dkg\n${end}\nmemory.provider: foreign\n`);
    expect(verifyHermesProfile({ hermesHome: home }).errors.join('\n')).toContain('effective memory.provider: dkg');
    config('memory:\n  provider: dkg\n');
    expect(verifyHermesProfile({ hermesHome: home }).errors.join('\n')).toContain('adapter-managed');
  });
  it('refuses an unowned plugin and reports missing bundled sources', () => {
    mkdirSync(join(home, 'plugins/dkg'), { recursive: true });
    put(join(home, 'plugins/dkg/user.py'), 'keep');
    expect(() => setup()).toThrow('non-managed Hermes DKG provider plugin');
    expect(readFileSync(join(home, 'plugins/dkg/user.py'), 'utf8')).toBe('keep');
    rmSync(join(home, 'plugins'), { recursive: true });
    fault.noPlugin = true;
    expect(() => setup()).toThrow('Bundled Hermes provider plugin was not found');
  });
});

describe('provider restoration', () => {
  it.each(['memory.provider: old\nother: keep\n', 'memory:\n  provider: old\n  enabled: true\nother: keep\n'])('surgically restores edited provider config: %s', (original) => {
    config(original); setup();
    config(original.replace('old', 'new') + 'user-edit: retained\n');
    const result = restoreHermesProfile({ hermesHome: home });
    expect(result).toEqual({ ok: true, path: 'surgical', restoredProvider: 'old' });
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(original + 'user-edit: retained\n');
  });
  it('restores the original file after config deletion', () => {
    config('memory:\n  provider: old\n'); setup();
    const backup = state().priorMemoryProvider.configBackupPath;
    rmSync(join(home, 'config.yaml'));
    expect(restoreHermesProfile({ hermesHome: home })).toEqual({ ok: true, path: 'backup-file', restoredFrom: backup });
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('memory:\n  provider: old\n');
    expect(existsSync(backup)).toBe(false);
  });
  it.each([new Error('disk unavailable'), 'disk unavailable'])('falls back after a surgical write failure: %s', (failure) => {
    config('memory:\n  provider: old\n'); setup();
    fault.write.set(join(home, 'config.yaml'), failure);
    expect(restoreHermesProfile({ hermesHome: home }).path).toBe('backup-file');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('provider: old');
  });
  it('reports corrupt backups and preserves failed restore evidence', () => {
    config('memory:\n  provider: old\n'); setup();
    config('user: edited\n');
    put(state().priorMemoryProvider.configBackupPath, 'unrelated: backup\n');
    expect(restoreHermesProfile({ hermesHome: home })).toMatchObject({ ok: false, path: 'failed', restoreError: expect.stringContaining('backup-file post-restore verification mismatch') });
  });
  it('reports a rename failure and honors pre-cancellation without touching files', () => {
    config('memory:\n  provider: old\n'); setup();
    const before = readFileSync(join(home, 'config.yaml'), 'utf8');
    expect(restoreHermesProfile({ hermesHome: home, signal: AbortSignal.abort() })).toMatchObject({ ok: false, restoreError: 'restore cancelled before start' });
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(before);
    rmSync(join(home, 'config.yaml')); mkdirSync(join(home, 'config.yaml'));
    expect(restoreHermesProfile({ hermesHome: home }).restoreError).toContain('backup-file rename failed');
  });
  it.each(['disconnect', 'uninstall'] as const)('dry-run %s preserves provider and backup', async (operation) => {
    config('memory:\n  provider: old\n'); setup();
    const before = readFileSync(stateFile(), 'utf8');
    await (operation === 'disconnect' ? runDisconnect : runUninstall)({ hermesHome: home, dryRun: true, restoreProvider: true });
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
    expect(existsSync(state().priorMemoryProvider.configBackupPath)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['disconnect', 'uninstall'] as const)('%s reports a failed restore without re-enabling integration', async (operation) => {
    config('memory:\n  provider: old\n'); setup();
    rmSync(state().priorMemoryProvider.configBackupPath); config('unrelated: retained\n');
    fetchMock.mockResolvedValue(Response.json({ integration: { metadata: { hermesHome: home } } }));
    await (operation === 'disconnect' ? runDisconnect : runUninstall)({ hermesHome: home, restoreProvider: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('restore-provider failed'));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/hermes'), expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"enabled":false') }));
  });
});

describe('setup orchestration boundaries', () => {
  it('bootstraps, creates wallets, starts and registers using the selected network and auth file', async () => {
    put(join(node, 'auth.token'), '# generated\n\n fixture-token\n');
    const loadOpWallets = vi.fn(async () => []);
    const result = await runHermesSetup({ hermesHome: home, network: 'testnet', daemonUrl: 'http://localhost', profile: 'test-profile' }, { loadOpWallets });
    expect(result).toMatchObject({ ok: true, status: 'configured', daemonStarted: true, fundedWallets: [] });
    expect(ensureDkgNodeConfig).toHaveBeenCalledWith(expect.objectContaining({ networkConfigName: 'testnet', apiPort: 9200, agentName: 'test-profile' }));
    expect(loadOpWallets).toHaveBeenCalledExactlyOnceWith(node);
    expect(startDaemon).toHaveBeenCalledExactlyOnceWith(9200);
    expect(fundWalletsBestEffort).toHaveBeenCalledWith(expect.objectContaining({ idempotencySeed: 'test-profile', didStartDaemon: true }));
    expect(fetchMock).toHaveBeenCalledWith('http://localhost/api/local-agent-integrations/connect', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }) }));
  });
  it.each([new Error('boundary unavailable'), 'boundary unavailable'])('reports failed bootstrap/start/funding and tolerates wallet pre-creation failure: %s', async (failure) => {
    vi.mocked(ensureDkgNodeConfig).mockImplementation(() => { throw failure; });
    vi.mocked(startDaemon).mockRejectedValue(failure);
    vi.mocked(fundWalletsBestEffort).mockRejectedValue(failure);
    const result = await runHermesSetup({ hermesHome: home, network: 'testnet', verify: false }, { loadOpWallets: vi.fn().mockRejectedValue(failure) });
    expect(result.ok).toBe(false);
    expect(result.daemonStarted).toBe(false);
    expect(result.errors).toEqual(['Failed to start DKG daemon: boundary unavailable']);
    expect(result.warnings).toEqual([expect.stringContaining('Could not bootstrap'), expect.stringContaining('Faucet orchestrator threw')]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not pre-create wallets'));
    expect(existsSync(stateFile())).toBe(true);
  });
  it('keeps an existing node network and does not shadow YAML with JSON', async () => {
    put(join(node, 'config.yaml'), 'networkConfig: testnet\n');
    const result = await runHermesSetup({ hermesHome: home, network: 'mainnet-gnosis', start: false, fund: false });
    expect(result.ok).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('--network mainnet-gnosis ignored'));
    expect(ensureDkgNodeConfig).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(fundWalletsBestEffort).not.toHaveBeenCalled();
    expect(existsSync(join(node, 'config.json'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reports missing network definitions as degraded without starting or funding', async () => {
    const result = await runHermesSetup({ hermesHome: home, network: 'test-nonexistent-network', start: false });
    expect(result).toMatchObject({ ok: true, status: 'degraded', daemonStarted: false });
    expect(result.warnings).toContainEqual(expect.stringContaining('Could not locate network/test-nonexistent-network.json'));
    expect(ensureDkgNodeConfig).not.toHaveBeenCalled();
    expect(fundWalletsBestEffort).not.toHaveBeenCalled();
  });
  it('returns setup errors and a usable transport description without registering partial setup', async () => {
    put(join(node, 'config.json'), { networkConfig: 'testnet' });
    put(join(home, 'dkg.json'), { managedBy: 'operator' });
    const result = await runHermesSetup({ hermesHome: home, start: false, fund: false });
    expect(result).toMatchObject({ ok: false, status: 'error', transport: { kind: 'hermes-openai', gatewayUrl: 'http://127.0.0.1:8642' } });
    expect(result.errors.join('\n')).toContain('Refusing to overwrite');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['primary', 'tools-only'] as const)('accepts CLI memory mode %s and explicit port', async (memoryMode) => {
    await runReconnect({ hermesHome: home, memoryMode, port: '9234', start: false, verify: true });
    expect(state().profile.memoryMode).toBe(memoryMode === 'primary' ? 'provider' : 'tools-only');
    expect(state().daemonUrl).toBe('http://127.0.0.1:9234');
    await runVerify({ hermesHome: home });
    await runDoctor({ hermesHome: home });
  });
  it('dry-run reconnect does not create files, then reconnect registers explicit bridge endpoints', async () => {
    await runReconnect({ hermesHome: home, dryRun: true });
    expect(existsSync(stateFile())).toBe(false);
    vi.stubEnv('DKG_AUTH_TOKEN', 'alias-token');
    await runReconnect({ hermesHome: home, bridgeUrl: 'http://127.0.0.1:7000', bridgeHealthUrl: 'http://127.0.0.1:7000/health', verify: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).transport).toEqual({ kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:7000', healthUrl: 'http://127.0.0.1:7000/health' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer alias-token');
  });
  it.each([0, -1, 65536, 1.5, 'bad'])('rejects invalid ports before side effects: %s', async (port) => {
    await expect(runStatus({ hermesHome: home, port })).rejects.toThrow('Invalid Hermes daemon port');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(stateFile())).toBe(false);
  });
  it.each(['ask', 'unsupported'])('rejects unsupported memory selection: %s', async (memoryMode) => {
    await expect(runStatus({ hermesHome: home, memoryMode: memoryMode as 'provider' })).rejects.toThrow(memoryMode === 'ask' ? 'non-interactive' : 'Invalid Hermes memory mode');
  });
  it.each(['http://127.0.0.1:9300', 'http://127.0.0.1:9200', 'http://localhost', 'invalid'])('handles port/URL conflict without changing URL: %s', async (daemonUrl) => {
    const result = await runHermesSetup({ hermesHome: home, daemonUrl, port: 9200, dryRun: true });
    expect(result.state?.daemonUrl).toBe(daemonUrl);
    expect(result.warnings.some((w) => w.includes('does not match'))).toBe(daemonUrl.endsWith('9300'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('managed files and bridge configuration', () => {
  it.each(['memory.provider: dkg\nother: keep\n', 'memory:\n  provider: dkg\nother: keep\n', 'memory:\n  enabled: true\nother: keep\n', 'memory:\n  provider: ""\n  provider: \'\'\nother: keep\n'])('elects DKG without losing unrelated YAML: %s', (raw) => {
    config(raw); setup();
    expect(verifyHermesProfile({ hermesHome: home }).ok).toBe(true);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('other: keep');
    disconnectHermesProfile({ hermesHome: home });
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('other: keep');
  });
  it('recognizes managed inline provider form and removes it on disconnect', () => {
    config(`${begin}\nmemory.provider: dkg\n${end}\nother: keep\n`);
    const plan = setup({ memoryMode: 'tools-only' });
    expect(plan.state.managedFiles).toContain(join(home, 'config.yaml'));
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('other: keep\n');
  });
  it('preserves unowned artifacts while removing owned skill and plugin files', () => {
    setup({ nodeSkillContent: '# Test node skill' });
    const snapshot = state();
    const keepDir = join(home, 'user-dir'); mkdirSync(keepDir);
    const keepJson = join(home, 'user.json'); put(keepJson, { operator: true });
    const keepText = join(home, 'user.txt'); put(keepText, 'keep');
    snapshot.managedFiles.push(keepDir, keepJson, keepText, join(home, 'absent'));
    put(stateFile(), snapshot);
    const before = readFileSync(stateFile(), 'utf8');
    uninstallHermesProfile({ hermesHome: home, dryRun: true });
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
    uninstallHermesProfile({ hermesHome: home });
    expect([keepDir, keepJson, keepText].every(existsSync)).toBe(true);
    expect(existsSync(join(home, 'skills/dkg-node/SKILL.md'))).toBe(false);
    expect(existsSync(join(home, 'plugins/dkg'))).toBe(false);
  });
  it('updates the last blank API key occurrence and tolerates unsupported file permissions', () => {
    put(join(home, '.env'), 'KEEP=yes\nAPI_SERVER_KEY=old\nexport API_SERVER_KEY=\nAPI_SERVER_ENABLED=false');
    fault.chmod = true;
    setup();
    const env = readFileSync(join(home, '.env'), 'utf8');
    expect(env).toContain('KEEP=yes\nAPI_SERVER_KEY=old\n');
    expect(env).toMatch(/API_SERVER_KEY=[A-Za-z0-9_-]{43}\nAPI_SERVER_ENABLED=true\n$/);
  });
  it.each([
    { bridgeUrl: 'not-a-url' }, { bridgeUrl: 'https://remote.example' },
    { bridgeHealthUrl: 'http://localhost/health' },
    { gatewayUrl: 'not-a-url', bridgeHealthUrl: 'http://localhost/health' },
    { gatewayUrl: 'http://localhost/api/hermes-channel', bridgeHealthUrl: 'http://localhost/api/other' },
    { gatewayUrl: 'http://localhost/path', bridgeHealthUrl: 'http://localhost/path-other' },
  ])('rejects health URLs outside the configured transport: %j', (options) => {
    expect(() => planHermesSetup({ hermesHome: home, ...options })).toThrow(/URL|transport/);
    expect(existsSync(stateFile())).toBe(false);
  });
  it.each([
    { bridgeUrl: 'http://[::1]:7000', bridgeHealthUrl: 'http://[::1]:7000/health' },
    { gatewayUrl: 'http://localhost/api/hermes-channel', bridgeHealthUrl: 'http://localhost/api/hermes-channel' },
    { gatewayUrl: 'http://localhost/base', bridgeHealthUrl: 'http://localhost/base/health' },
  ])('accepts matching loopback and gateway health URLs: %j', (options) => {
    const plan = planHermesSetup({ hermesHome: home, ...options });
    expect(plan.state.bridge?.healthUrl).toBe(options.bridgeHealthUrl);
  });
  it.each([undefined, {}, { metadata: 'invalid' }, { metadata: {} }])('does not disconnect a daemon integration without matching profile metadata: %j', async (integration) => {
    setup();
    fetchMock.mockImplementation(async () => Response.json({ integration }));
    await runDisconnect({ hermesHome: home });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('different profile'));
  });
  it.each([new Error('Bearer sensitive'), 'Bearer sensitive'])('redacts best-effort registration and disconnect failures: %s', async (failure) => {
    put(join(node, 'auth.token'), '# no active token\n');
    fetchMock.mockRejectedValue(failure);
    await runReconnect({ hermesHome: home });
    await runDisconnect({ hermesHome: home });
    expect(console.warn).toHaveBeenCalledWith('Hermes local-agent registration skipped: Bearer [REDACTED]');
    expect(console.warn).toHaveBeenCalledWith('Hermes local-agent registry disconnect skipped: Bearer [REDACTED]');
  });
});

describe('recovery diagnostics', () => {
  it.each(['surgical', 'backup-file'] as const)('prints a successful %s restore from disconnect', async (path) => {
    config('memory:\n  provider: previous\n'); setup();
    if (path === 'backup-file') config('user-edit: preserved-only-by-surgical\n');
    await runDisconnect({ hermesHome: home, restoreProvider: true });
    expect(console.log).toHaveBeenCalledWith(`Hermes restore: path=${path}`);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('provider: previous');
  });
  it('always restores the prior provider before uninstall removes its state', async () => {
    config('memory:\n  provider: previous\n'); setup();
    await runUninstall({ hermesHome: home });
    expect(console.log).toHaveBeenCalledWith('Hermes uninstall: restore: path=surgical');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('provider: previous');
    expect(existsSync(stateFile())).toBe(false);
  });
  it('falls back to the backup when a quoted provider cannot be restored by an unquoted rewrite', () => {
    config('memory:\n  provider: "custom provider"\n'); setup();
    config('memory:\n  provider: edited\n');
    expect(restoreHermesProfile({ hermesHome: home }).path).toBe('backup-file');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('memory:\n  provider: "custom provider"\n');
  });
  it.each([new Error('network config unreadable'), 'network config unreadable'])('reports unreadable network definitions: %s', async (failure) => {
    fault.read.set('/network/testnet.json', failure);
    const result = await runHermesSetup({ hermesHome: home, network: 'testnet', start: false });
    expect(result.status).toBe('degraded');
    expect(result.warnings).toContainEqual(expect.stringContaining('network config unreadable'));
    expect(ensureDkgNodeConfig).not.toHaveBeenCalled();
    expect(fundWalletsBestEffort).not.toHaveBeenCalled();
  });
  it('checks the final on-disk provider after registration', async () => {
    fetchMock.mockImplementation(async () => { config('memory:\n  provider: operator-change\n'); return Response.json({ ok: true }); });
    await expect(runReconnect({ hermesHome: home })).rejects.toThrow('already has memory.provider: operator-change');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('operator-change');
  });
  it('reports a non-Error setup failure as an error result', async () => {
    put(join(node, 'config.json'), {});
    fault.write.set(join(home, 'dkg.json'), 'read-only profile');
    const result = await runHermesSetup({ hermesHome: home, start: false, fund: false, verify: false });
    expect(result.errors).toEqual(['read-only profile']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('ignores a conflicting network flag on legacy node config without degrading setup', async () => {
    put(join(node, 'config.json'), {});
    const result = await runHermesSetup({ hermesHome: home, network: 'mainnet-gnosis', start: false, fund: false });
    expect(result.status).toBe('configured');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('has no explicit network'));
  });
  it('does not misread a managed block containing unrelated YAML as provider ownership', () => {
    config(`${begin}\nother: keep\n${end}\nmemory:\n  provider: dkg\n`);
    expect(planHermesSetup({ hermesHome: home, memoryMode: 'tools-only' }).state.managedFiles).not.toContain(join(home, 'config.yaml'));
  });
});
