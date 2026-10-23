import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_CONFIG_FILENAME, DEFAULT_PUBLISH_GUARD, MANAGED_BY, SETUP_STATE_FILENAME,
  PrimeAgentAdapterPlugin, PRIME_AGENT_ADAPTER_VERSION,
  defaultExtensionPath, disconnectPrimeAgentProfile, loadDkgAuthToken,
  readSettings, readSetupState, resolveAgentDir, resolvePrimeAgentProfile, restorePrimeAgentProfile,
  runDisconnect, runDoctor, runPrimeAgentSetup, runReconnect, runSetup, runStatus, runUninstall,
  runVerify, setupPrimeAgentProfile, verifyPrimeAgentProfile, writeSessionDescriptor,
  type DaemonPluginApi,
} from '../src/index.js';

let root: string;
let agentDir: string;
let dkgHome: string;
let extensionPath: string;
const token = 'fixture-only-bridge-token';
const settingsPath = () => join(agentDir, 'settings.json');
const profile = () => resolvePrimeAgentProfile({ agentDir });
const options = () => ({ agentDir, dkgHome, extensionPath });
const setup = () => setupPrimeAgentProfile(options());
const writeSettings = (value: unknown) => writeFileSync(settingsPath(), JSON.stringify(value));
const liveSession = () => ({
  sessionId: 'fixture-session', bridgeUrl: 'http://127.0.0.1:45123', pid: process.pid,
  startedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prime-lifecycle-'));
  agentDir = join(root, 'agent');
  dkgHome = join(root, 'dkg');
  extensionPath = join(root, 'extension.js');
  mkdirSync(agentDir);
  mkdirSync(dkgHome);
  writeFileSync(extensionPath, 'export default () => {};\n');
  writeFileSync(join(dkgHome, 'auth.token'), `# fixture\n \n ${token} \nignored-second-token\n`);
  vi.stubEnv('PRIME_AGENT_CODING_AGENT_DIR', agentDir);
  vi.stubEnv('DKG_HOME', dkgHome);
  vi.stubEnv('DKG_API_TOKEN', '');
  vi.stubEnv('DKG_AUTH_TOKEN', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('setup planning and credentials', () => {
  it('resolves explicit paths before the environment and isolates profile metadata', () => {
    expect(resolveAgentDir('relative-agent')).toBe(resolve('relative-agent'));
    expect(resolveAgentDir()).toBe(agentDir);
    vi.stubEnv('PRIME_AGENT_CODING_AGENT_DIR', '');
    expect(resolveAgentDir()).toBe(join(homedir(), '.prime', 'agent'));
    expect(resolvePrimeAgentProfile({ agentDir, profileName: 'named', memoryMode: 'tools-only' }))
      .toMatchObject({ profileName: 'named', agentDir, memoryMode: 'tools-only' });
    expect(() => resolvePrimeAgentProfile({ profileName: '../escape' })).toThrow(/path separators/);
    expect(() => resolvePrimeAgentProfile({ profileName: 'a\\b' })).toThrow(/path separators/);
  });

  it('resolves trimmed API, auth, and file tokens in order without returning comments', () => {
    expect(loadDkgAuthToken(dkgHome)).toBe(token);
    vi.stubEnv('DKG_AUTH_TOKEN', ' auth-token ');
    expect(loadDkgAuthToken(dkgHome)).toBe('auth-token');
    vi.stubEnv('DKG_API_TOKEN', ' api-token ');
    expect(loadDkgAuthToken(dkgHome)).toBe('api-token');
    vi.stubEnv('DKG_API_TOKEN', ' \n ');
    vi.stubEnv('DKG_AUTH_TOKEN', '');
    writeFileSync(join(dkgHome, 'auth.token'), '# comments only\n \n');
    expect(loadDkgAuthToken(dkgHome)).toBeUndefined();
    rmSync(join(dkgHome, 'auth.token'));
    expect(loadDkgAuthToken(dkgHome)).toBeUndefined();
  });

  it('refuses a missing credential before creating state or changing settings', () => {
    writeSettings({ extensions: ['/user.js'], theme: 'dark' });
    const original = readFileSync(settingsPath(), 'utf8');
    rmSync(join(dkgHome, 'auth.token'));
    expect(() => setup()).toThrow(/DKG auth token not found/);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(original);
    expect(existsSync(profile().stateDir)).toBe(false);
  });

  it('plans missing prerequisites without creating directories or requiring credentials', () => {
    rmSync(agentDir, { recursive: true });
    rmSync(extensionPath);
    const plan = setupPrimeAgentProfile({ ...options(), dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings.join('\n')).toMatch(/config dir not found/);
    expect(plan.warnings.join('\n')).toMatch(/extension bundle missing/);
    expect(plan.actions.filter(a => a.type === 'create')).toHaveLength(3);
    expect(existsSync(agentDir)).toBe(false);
  });

  it('preserve-settings blocks conflicting owned entries but allows a first installation', () => {
    const old = '/old/adapter-prime-agent/extension.js';
    writeSettings({ extensions: [old, '/user.js'], theme: 'dark' });
    const original = readFileSync(settingsPath(), 'utf8');
    const blocked = setupPrimeAgentProfile({ ...options(), preserveSettings: true });
    expect(blocked.actions).toContainEqual({ type: 'skip', path: settingsPath(), reason: 'preserve-settings' });
    expect(blocked.warnings.join('\n')).toContain(old);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(original);
    expect(blocked.state.priorSettings).toBeUndefined();
    writeSettings({ extensions: ['/user.js'], theme: 'dark' });
    setupPrimeAgentProfile({ ...options(), preserveSettings: true });
    expect(readSettings(settingsPath())).toEqual({ extensions: ['/user.js', extensionPath], theme: 'dark' });
  });

  it.each([null, 3, 'text', false])('handles primitive settings %j as an empty configuration', value => {
    writeSettings(value);
    expect(readSettings(settingsPath())).toEqual({});
    setup();
    expect(readSettings(settingsPath())).toEqual({ extensions: [extensionPath] });
  });

  it('treats an invalid extensions field as empty while preserving other settings', () => {
    writeSettings({ extensions: 'invalid', theme: 'light' });
    setup();
    expect(readSettings(settingsPath())).toEqual({ extensions: [extensionPath], theme: 'light' });
  });

  it('retains the first snapshot and settings defaults while repairing config permissions', () => {
    writeSettings({ extensions: ['/user.js'] });
    const first = setupPrimeAgentProfile({ ...options(), daemonUrl: 'http://localhost:9321', contextGraph: 'custom', memoryAssertion: 'notes' });
    const configPath = join(profile().stateDir, ADAPTER_CONFIG_FILENAME);
    rmSync(configPath);
    writeFileSync(configPath, '{}', { mode: 0o644 });
    const next = setup();
    expect(next.state).toMatchObject({
      installedAt: first.state.installedAt, priorSettings: first.state.priorSettings,
      daemonUrl: 'http://localhost:9321', contextGraph: 'custom', memoryAssertion: 'notes',
      publishGuard: DEFAULT_PUBLISH_GUARD,
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(next.actions.filter(a => a.type === 'update').map(a => a.path))
      .toEqual([join(profile().stateDir, SETUP_STATE_FILENAME), configPath]);
    expect(readdirSync(agentDir).filter(name => name.includes('.bak.'))).toHaveLength(1);
  });
});

describe('verification and restore', () => {
  it('reports an unconfigured or corrupted state without changing it', () => {
    expect(verifyPrimeAgentProfile(options())).toMatchObject({ ok: false, status: 'error', sessions: [] });
    expect(restorePrimeAgentProfile({ agentDir })).toEqual({ ok: true, path: 'noop' });
    mkdirSync(profile().stateDir);
    const path = join(profile().stateDir, SETUP_STATE_FILENAME);
    writeFileSync(path, '{broken');
    expect(readSetupState(profile())).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  it('distinguishes an installed idle adapter from a live session and advisory co-extensions', () => {
    writeSettings({ extensions: ['/user.js'] });
    setup();
    const idle = verifyPrimeAgentProfile(options());
    expect(idle).toMatchObject({ ok: true, status: 'degraded', errors: [], sessions: [] });
    expect(idle.warnings).toHaveLength(2);
    expect(idle.warnings.join('\n')).toContain('advisory');
    const descriptor = liveSession();
    writeSessionDescriptor(profile().sessionsDir, descriptor);
    const active = verifyPrimeAgentProfile(options());
    expect(active).toMatchObject({ ok: true, status: 'configured', errors: [], sessions: [descriptor] });
    expect(active.warnings).toHaveLength(1);
  });

  it.each([
    ['missing', []],
    ['duplicates', ['CURRENT', 'CURRENT']],
    ['stale', ['CURRENT', '/old/adapter-prime-agent/extension.js']],
  ])('rejects %s extension registration', (kind, entries) => {
    setup();
    writeSettings({ extensions: entries.map(e => e === 'CURRENT' ? extensionPath : e) });
    const result = verifyPrimeAgentProfile(options());
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(kind === 'missing' ? /not registered/ : kind === 'duplicates' ? /registered 2 times/ : /stale/);
  });

  it('reports missing bundles, malformed settings, and invalid config ownership and credentials', () => {
    setup();
    rmSync(extensionPath);
    writeFileSync(settingsPath(), '{editing');
    const configPath = join(profile().stateDir, ADAPTER_CONFIG_FILENAME);
    writeFileSync(configPath, JSON.stringify({ managedBy: 'someone-else', bridge_token: ' ' }));
    const result = verifyPrimeAgentProfile(options());
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(4);
    expect(result.errors.join('\n')).toMatch(/bundle missing/);
    expect(result.errors.join('\n')).toMatch(/not valid JSON/);
    expect(result.errors.join('\n')).toMatch(/not owned/);
    expect(result.errors.join('\n')).toMatch(/token is missing/);
    rmSync(configPath);
    expect(verifyPrimeAgentProfile(options()).errors.join('\n')).toMatch(/config unavailable/);
  });

  it('surgically removes only owned entries and keeps later user edits', () => {
    setup();
    writeSettings({ extensions: [extensionPath, '/new-user.js', '/old/adapter-prime-agent/extension.js'], theme: 'new' });
    expect(restorePrimeAgentProfile({ agentDir })).toEqual({ ok: true, path: 'surgical' });
    expect(readSettings(settingsPath())).toEqual({ extensions: ['/new-user.js'], theme: 'new' });
    expect(restorePrimeAgentProfile({ agentDir })).toEqual({ ok: true, path: 'noop' });
  });

  it('fails safely when malformed settings have no retained backup', () => {
    setup(); // No settings file existed, so no backup file was created.
    writeFileSync(settingsPath(), '{editing');
    const result = restorePrimeAgentProfile({ agentDir });
    expect(result).toMatchObject({ ok: false, path: 'failed' });
    expect(result.restoreError).toMatch(/not valid JSON/);
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{editing');
  });

  it.each(['malformed', 'still-owned'])('rejects an unsafe %s backup and preserves the rejected original', kind => {
    writeSettings({ extensions: [] });
    setup();
    const backup = readSetupState(profile())!.priorSettings!.settingsBackupPath;
    writeFileSync(backup, kind === 'malformed' ? '{broken backup' : JSON.stringify({ extensions: [extensionPath] }));
    writeFileSync(settingsPath(), '{unfinished original');
    const result = restorePrimeAgentProfile({ agentDir });
    expect(result).toMatchObject({ ok: false, path: 'failed' });
    expect(result.restoreError).toMatch(kind === 'malformed' ? /not valid JSON/ : /entry present in backup/);
    const rejected = readdirSync(agentDir).filter(name => name.includes('.rejected.'));
    expect(rejected).toHaveLength(1);
    expect(readFileSync(join(agentDir, rejected[0]), 'utf8')).toBe('{unfinished original');
  });

  it('disconnect dry runs preserve registration and real disconnects persist their status', () => {
    setup();
    disconnectPrimeAgentProfile({ ...options(), dryRun: true });
    expect(readSettings(settingsPath()).extensions).toEqual([extensionPath]);
    expect(readSetupState(profile())!.status).toBe('configured');
    disconnectPrimeAgentProfile(options());
    expect(readSettings(settingsPath()).extensions).toEqual([]);
    expect(readSetupState(profile())!.status).toBe('disconnected');
  });
});

describe('orchestration and CLI results', () => {
  it('forwards request options, elects a live session, and exposes its health URL', async () => {
    setup();
    writeSessionDescriptor(profile().sessionsDir, liveSession());
    const result = await runPrimeAgentSetup({ agentDir, dkgHome, profile: 'named', memoryMode: 'tools-only',
      daemonUrl: 'http://localhost:9321', bridgeToken: ' explicit ', contextGraph: 'custom', memoryAssertion: 'notes', preserveSettings: false });
    expect(result).toMatchObject({ ok: true, status: 'configured', settingsPatched: true, errors: [],
      profile: { profileName: 'named', memoryMode: 'tools-only' },
      transport: { kind: 'prime-agent-channel', bridgeUrl: liveSession().bridgeUrl, healthUrl: `${liveSession().bridgeUrl}/health` } });
    const config = JSON.parse(readFileSync(join(profile().stateDir, ADAPTER_CONFIG_FILENAME), 'utf8'));
    expect(config).toMatchObject({ managedBy: MANAGED_BY, bridge_token: 'explicit', memory_mode: 'tools-only',
      context_graph: 'custom', memory_assertion: 'notes', daemon_url: 'http://localhost:9321' });
    expect(result.state!.extensionPath).toBe(defaultExtensionPath());
  });

  it('dry run and verify=false avoid verification while setup failures remain structured', async () => {
    const dry = await runPrimeAgentSetup({ agentDir, dkgHome, dryRun: true });
    expect(dry).toMatchObject({ ok: true, status: 'degraded', errors: [], transport: { kind: 'prime-agent-channel' } });
    expect(existsSync(profile().stateDir)).toBe(false);
    const result = await runPrimeAgentSetup({ agentDir, dkgHome, verify: false });
    expect(result).toMatchObject({ ok: true, status: 'degraded', errors: [], warnings: [] });
    rmSync(join(dkgHome, 'auth.token'));
    const failed = await runPrimeAgentSetup({ agentDir, dkgHome });
    expect(failed).toMatchObject({ ok: false, status: 'error', settingsPatched: false });
    expect(failed.errors.join('\n')).toMatch(/DKG auth token not found/);
  });

  it('verification failure after a preserve-settings setup is returned to the caller', async () => {
    writeSettings({ extensions: ['/old/adapter-prime-agent/extension.js'] });
    const result = await runPrimeAgentSetup({ agentDir, dkgHome, preserveSettings: true });
    expect(result).toMatchObject({ ok: false, status: 'error', settingsPatched: false });
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join('\n')).toMatch(/not registered/);
    expect(result.errors.join('\n')).toMatch(/stale/);
  });

  it('CLI verbs expose status, warnings, failures, disconnect and reconnect through observable output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runStatus(options());
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ configured: false, status: 'disconnected', sessions: [] });
    await runDoctor(options());
    expect(log.mock.calls.at(-1)![0]).toMatch(/settings.json\s+: MISSING/);
    expect(log.mock.calls.at(-1)![0]).toContain('not set up');
    await expect(runVerify(options())).rejects.toThrow('verification failed');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not set up'));
    await runSetup({ agentDir, dkgHome });
    expect(log).toHaveBeenCalledWith('[prime-agent] degraded; settings patched: true');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no live Prime Agent session'));
    await runVerify(options());
    expect(log).toHaveBeenCalledWith('[prime-agent] degraded; live sessions: 0');
    writeSessionDescriptor(profile().sessionsDir, liveSession());
    await runDoctor(options());
    expect(log.mock.calls.at(-1)![0]).toMatch(/live sessions\s+: 1/);
    expect(log.mock.calls.at(-1)![0]).not.toContain('no session running');
    await runStatus(options());
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ configured: true, status: 'configured', sessions: [liveSession()] });
    await runDisconnect(options());
    expect(log).toHaveBeenCalledWith('[prime-agent] disconnected');
    await runReconnect(options());
    expect(readSettings(settingsPath()).extensions).toEqual([defaultExtensionPath()]);
    rmSync(join(dkgHome, 'auth.token'));
    await expect(runSetup({ agentDir, dkgHome })).rejects.toThrow(/DKG auth token not found/);
  });

  it('uninstall dry runs retain wiring; recovery reports the preserved file and backup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeSettings({ extensions: [], theme: 'original' });
    setup();
    await runUninstall({ ...options(), dryRun: true });
    expect(readSettings(settingsPath()).extensions).toEqual([extensionPath]);
    writeFileSync(settingsPath(), '{unfinished');
    await runUninstall(options());
    expect(readSettings(settingsPath())).toEqual({ extensions: [], theme: 'original' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preserved replaced settings'));
    expect(log.mock.calls.at(-1)![0]).toMatch(/uninstalled \(backup retained at/);
    await runUninstall(options());
    expect(log.mock.calls.at(-1)![0]).toBe('[prime-agent] uninstalled');
    rmSync(readSetupState(profile())!.priorSettings!.settingsBackupPath);
    writeFileSync(settingsPath(), '{unfinished again');
    await expect(runUninstall(options())).rejects.toThrow(/failed to uninstall/);
  });
});

describe('daemon plugin registration', () => {
  it.each([true, false])('registers a real status handler and shutdown hook exactly once (logger=%s)', withLogger => {
    const api: DaemonPluginApi = { registerHttpRoute: vi.fn(), registerHook: vi.fn(),
      ...(withLogger ? { logger: { info: vi.fn(), debug: vi.fn() } } : {}) };
    const config = { daemonUrl: 'http://localhost:9321' };
    const plugin = new PrimeAgentAdapterPlugin(config);
    expect(plugin.config).toBe(config);
    expect(new PrimeAgentAdapterPlugin().config).toEqual({});
    plugin.register(api);
    plugin.register(api);
    expect(api.registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const route = vi.mocked(api.registerHttpRoute).mock.calls[0][0];
    expect(route).toMatchObject({ method: 'GET', path: '/api/prime-agent/status' });
    const response = { writeHead: vi.fn(), end: vi.fn() };
    route.handler({}, response);
    expect(response.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ adapter: 'prime-agent', framework: 'prime-intellect-prime-agent', status: 'connected', version: PRIME_AGENT_ADAPTER_VERSION });
    const [event, handler, opts] = vi.mocked(api.registerHook).mock.calls[0];
    expect(event).toBe('session_end');
    expect(opts).toEqual({ name: 'prime-agent-adapter-stop' });
    handler();
    if (withLogger) {
      expect(api.logger!.info).toHaveBeenCalledWith('[dkg-adapter-prime-agent] registered');
      expect(api.logger!.debug).toHaveBeenCalledWith('[dkg-adapter-prime-agent] session_end');
      expect(api.logger!.debug).toHaveBeenCalledWith('[dkg-adapter-prime-agent] already registered; skipping');
    }
  });
});
