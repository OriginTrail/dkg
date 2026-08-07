import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionBridge } from '../extension/src/extension.js';
import {
  ADAPTER_CONFIG_FILENAME,
  defaultExtensionPath,
  disconnectPrimeAgentProfile,
  readSetupState,
  resolvePrimeAgentProfile,
  restorePrimeAgentProfile,
  setupPrimeAgentProfile,
} from '../src/setup.js';

const TOKEN = 'node-auth-token-from-file';
let root: string;
let agentDir: string;
let dkgHome: string;
let extensionPath: string;
let bridge: SessionBridge | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prime-agent-setup-'));
  agentDir = join(root, 'prime-agent');
  dkgHome = join(root, 'dkg-home');
  extensionPath = join(root, 'packages', 'adapter-prime-agent', 'extension', 'dist', 'extension.js');
  mkdirSync(dirname(extensionPath), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dkgHome, { recursive: true });
  writeFileSync(extensionPath, 'export default () => {};\n');
  writeFileSync(join(dkgHome, 'auth.token'), `# managed\n${TOKEN}\n`);
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
  delete process.env.DKG_BRIDGE_TOKEN;
  delete process.env.DKG_API_TOKEN;
  delete process.env.DKG_AUTH_TOKEN;
});

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
  delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
  delete process.env.DKG_BRIDGE_TOKEN;
  delete process.env.DKG_API_TOKEN;
  delete process.env.DKG_AUTH_TOKEN;
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  return setupPrimeAgentProfile({ agentDir, dkgHome, extensionPath });
}

describe('setup package and credential contract', () => {
  it('builds the extension bundle at the path setup registers', () => {
    expect(existsSync(defaultExtensionPath())).toBe(true);
  });

  it('hard-fails before changing settings when the shipped extension bundle is absent', () => {
    const missing = join(root, 'missing', 'dkg-adapter-prime-agent', 'extension.js');
    expect(() => setupPrimeAgentProfile({ agentDir, dkgHome, extensionPath: missing })).toThrow(
      /extension bundle missing/i,
    );
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false);
  });

  it('writes a private dkg.json from the node auth token and the bridge accepts it', async () => {
    setup();
    const profile = resolvePrimeAgentProfile({ agentDir });
    const configPath = join(profile.stateDir, ADAPTER_CONFIG_FILENAME);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.bridge_token).toBe(TOKEN);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    bridge = new SessionBridge({ on: () => {}, sendUserMessage: () => {} } as never, 'token-e2e');
    await bridge.start();
    const descriptor = JSON.parse(
      readFileSync(join(profile.sessionsDir, 'token-e2e.json'), 'utf8'),
    ) as { bridgeUrl: string };
    const accepted = await fetch(`${descriptor.bridgeUrl}/health`, {
      headers: { 'x-dkg-bridge-token': TOKEN },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, sessionId: 'token-e2e' });
  });
});

describe('idempotence and recovery', () => {
  it('never overwrites the first-run settings backup on a re-run', () => {
    const settingsPath = join(agentDir, 'settings.json');
    const original = '{"theme":"original","extensions":[]}\n';
    writeFileSync(settingsPath, original);
    setup();
    const profile = resolvePrimeAgentProfile({ agentDir });
    const backupPath = readSetupState(profile)!.priorSettings!.settingsBackupPath;
    expect(readFileSync(backupPath, 'utf8')).toBe(original);

    writeFileSync(settingsPath, '{"theme":"changed","extensions":[]}\n');
    setup();
    expect(readFileSync(backupPath, 'utf8')).toBe(original);
  });

  it('replaces stale adapter install paths instead of registering duplicates', () => {
    const settingsPath = join(agentDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ extensions: ['/old/node_modules/dkg-adapter-prime-agent/extension.js', '/user/ext.js'] }),
    );
    setup();
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.extensions).toEqual(['/user/ext.js', extensionPath]);
  });

  it('is idempotent when the exact source-tree extension path is already registered', () => {
    setup();
    setup();

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toEqual([extensionPath]);
  });

  it('disconnect removes a source-tree extension path', () => {
    setup();
    disconnectPrimeAgentProfile({ agentDir, dkgHome, extensionPath });

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toEqual([]);
  });

  it('disconnect removes the exact persisted extension path even without a managed-looking name', () => {
    const customPath = join(root, 'custom', 'extension', 'dist', 'extension.js');
    mkdirSync(dirname(customPath), { recursive: true });
    writeFileSync(customPath, 'export default () => {};\n');
    setupPrimeAgentProfile({ agentDir, dkgHome, extensionPath: customPath });

    disconnectPrimeAgentProfile({ agentDir, dkgHome, extensionPath: customPath });

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toEqual([]);
  });

  it('reconnect after disconnect registers exactly one extension entry', () => {
    setup();
    disconnectPrimeAgentProfile({ agentDir, dkgHome, extensionPath });
    setup();

    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toEqual([extensionPath]);
  });

  it('preserves malformed user settings before restoring the retained backup', () => {
    const settingsPath = join(agentDir, 'settings.json');
    writeFileSync(settingsPath, '{"theme":"original","extensions":[]}\n');
    setup();
    writeFileSync(settingsPath, '{half-edited');

    const restored = restorePrimeAgentProfile({ agentDir });
    expect(restored).toMatchObject({ ok: true, path: 'backup-file' });
    expect(restored.rejectedPath).toBeTruthy();
    expect(readFileSync(restored.rejectedPath!, 'utf8')).toBe('{half-edited');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ theme: 'original' });
    expect(existsSync(restored.restoredFrom!)).toBe(true);
  });
});
