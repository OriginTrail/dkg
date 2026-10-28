import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runCli, isKnownCliSubcommand } from '../src/cli/index.js';
import { fetchManifest } from '../src/manifest/fetch.js';
import type { ProjectManifest } from '../src/manifest/schema.js';

vi.mock('../src/manifest/fetch.js', () => ({ fetchManifest: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));
let root: string;
let workspace: string;
let home: string;
let manifest: ProjectManifest;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let question: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const wallet = `0x${'AB'.repeat(20)}`;
const peer = `12D3Koo${'A'.repeat(45)}`;
const template = (text: string) => ({ uri: 'urn:template', encodingFormat: 'text/plain', text });
const output = () =>
  vi
    .mocked(console.log)
    .mock.calls.map((args) => args.join(' '))
    .join('\n');
const warnings = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map((args) => args.join(' '))
    .join('\n');
function write(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function responseFor(url: string): Response {
  if (url.endsWith('/api/context-graph/list'))
    return Response.json({ contextGraphs: [{ id: 'team', name: 'Team' }, { id: 'other' }] });
  if (url.endsWith('/api/agent/identity')) return Response.json({ agentAddress: wallet });
  if (url.endsWith('/api/connect') || url.endsWith('/api/context-graph/subscribe'))
    return Response.json({ ok: true });
  throw new Error(`Unexpected daemon request: ${url}`);
}
beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-test-'));
  workspace = path.join(root, 'workspace');
  home = path.join(root, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  for (const key of [
    'DKG_API',
    'DKG_TOKEN',
    'DEVNET_API',
    'DEVNET_TOKEN',
    'DKG_AUTH',
    'DKG_PROJECT',
    'DKG_AGENT_URI',
  ])
    vi.stubEnv(key, undefined);
  // Config lookup and all home-directory writes remain inside this test's tree.
  vi.stubEnv('DKG_HOME', path.join(home, '.dkg'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(os, 'hostname').mockReturnValue('laptop.example');
  vi.spyOn(os, 'userInfo').mockReturnValue({
    username: 'alice',
    uid: 1,
    gid: 1,
    shell: '/bin/sh',
    homedir: home,
  });
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  fetcher = vi.fn<typeof fetch>(async (input) => responseFor(String(input)));
  vi.stubGlobal('fetch', fetcher);
  manifest = {
    uri: 'urn:manifest:team',
    contextGraphId: 'team',
    network: 'testnet',
    supportedTools: ['cursor', 'claude-code'],
    agentsMd: template('{{agentUri}} {{agentSlug}} {{contextGraphId}}'),
  };
  vi.mocked(fetchManifest).mockImplementation(async () => manifest);
  question = vi.fn().mockResolvedValue('');
  close = vi.fn();
  vi.mocked(createInterface).mockReturnValue({ question, close } as unknown as ReturnType<
    typeof createInterface
  >);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
async function join(extra: string[] = [], invite = 'team') {
  const result = runCli([
    'join',
    invite,
    `--workspace=${workspace}`,
    '--agent-slug=alice',
    '--yes',
    ...extra,
  ]);
  await vi.runAllTimersAsync();
  return result;
}

describe('operator command dispatch', () => {
  it.each(['help', '--help', '-h'])('prints usage without daemon access for %s', async (sub) => {
    expect(isKnownCliSubcommand(sub)).toBe(true);
    expect(await runCli([sub])).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('USAGE'));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses an unknown command and malformed join arguments', async () => {
    expect(isKnownCliSubcommand('typo')).toBe(false);
    expect(await runCli(['typo'])).toBe(1);
    expect(await runCli(['join'])).toBe(2);
    expect(await runCli(['join', 'team', '--unknown'])).toBe(2);
    expect(await join([], 'team\ninvalid-peer')).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('join through the real client and filesystem installer', () => {
  it('subscribes before fetching the manifest and writes wallet-based attribution', async () => {
    write(path.join(home, '.dkg/auth.token'), '# daemon token\nlocal-token\n');
    let subscribed = false;
    fetcher.mockImplementation(async (input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer local-token' });
      if (String(input).endsWith('/subscribe')) {
        expect(JSON.parse(String(init?.body))).toEqual({ contextGraphId: 'team' });
        subscribed = true;
      }
      return responseFor(String(input));
    });
    vi.mocked(fetchManifest).mockImplementation(async ({ contextGraphId }) => {
      expect(subscribed).toBe(true);
      expect(contextGraphId).toBe('team');
      return manifest;
    });
    expect(await join(['--daemon=http://daemon.test:1234'])).toBe(0);
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe(
      `urn:dkg:agent:${wallet.toLowerCase()} alice team`,
    );
    expect(output()).toContain('Installed 1 file');
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith('http://daemon.test:1234/')),
    ).toBe(true);
  });

  it.each(['explicit', 'environment', 'config', 'file', 'empty-file', 'missing-file'] as const)(
    'resolves %s credentials before the first request',
    async (mode) => {
      write(path.join(home, '.dkg/config.yaml'), 'node:\n  token: config-token\n');
      write(path.join(home, '.dkg/auth.token'), '# token\nfile-token\n');
      const extra: string[] = ['--no-subscribe', '--dry-run'];
      if (mode === 'explicit') extra.push('--token=explicit-token');
      if (mode === 'environment') vi.stubEnv('DKG_TOKEN', 'env-token');
      if (!['explicit', 'environment', 'config'].includes(mode))
        fs.rmSync(path.join(home, '.dkg/config.yaml'));
      if (mode === 'empty-file') write(path.join(home, '.dkg/auth.token'), '# only a comment\n');
      if (mode === 'missing-file') fs.rmSync(path.join(home, '.dkg/auth.token'));
      expect(await join(extra)).toBe(0);
      const expected = {
        explicit: 'explicit-token',
        environment: 'env-token',
        config: 'config-token',
        file: 'file-token',
        'empty-file': '',
        'missing-file': '',
      }[mode];
      expect(fetcher.mock.calls[0][1]?.headers).toEqual(
        expected ? { Authorization: `Bearer ${expected}` } : {},
      );
      expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false);
    },
  );

  it.each([401, 503])(
    'stops on daemon HTTP %i before subscription or installation',
    async (status) => {
      fetcher.mockResolvedValue(Response.json({ error: 'unavailable' }, { status }));
      expect(await join()).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetchManifest).not.toHaveBeenCalled();
      expect(fs.readdirSync(workspace)).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(status === 401 ? 'requires auth' : 'no daemon reachable'),
      );
    },
  );

  it.each([
    { invite: `team\n${peer}`, body: { peerId: peer } },
    { invite: 'team @ /ip4/127.0.0.1/tcp/4001', body: { multiaddr: '/ip4/127.0.0.1/tcp/4001' } },
  ])('dials the curator before subscribing: $invite', async ({ invite, body }) => {
    expect(await join(['--dry-run'], invite)).toBe(0);
    const calls = fetcher.mock.calls;
    expect(calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/context-graph/list',
      '/api/connect',
      '/api/context-graph/subscribe',
      '/api/agent/identity',
    ]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual(body);
  });
  it.each([`team\n${peer}`, 'team @ /ip4/127.0.0.1/tcp/4001'])(
    'continues to the locally available manifest after dial/subscription failure: %s',
    async (invite) => {
      fetcher.mockImplementation(async (input) => {
        const url = String(input);
        return url.endsWith('/api/connect') || url.endsWith('/subscribe')
          ? Response.json({ error: 'temporarily offline' }, { status: 503 })
          : responseFor(url);
      });
      expect(await join(['--dry-run'], invite)).toBe(0);
      expect(warnings()).toContain('could not dial curator');
      expect(warnings()).toContain('subscribe call returned a warning');
      expect(fetchManifest).toHaveBeenCalledTimes(1);
    },
  );
  it('does not write when manifest retrieval fails', async () => {
    vi.mocked(fetchManifest).mockRejectedValue(new Error('manifest missing'));
    expect(await join(['--no-subscribe'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith('[join] manifest missing');
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
  it.each(['peer', 'missing', 'unavailable'] as const)(
    'falls back to the slug for %s identity',
    async (mode) => {
      fetcher.mockImplementation(async (input) =>
        String(input).endsWith('/identity')
          ? mode === 'unavailable'
            ? Response.json({ error: 'offline' }, { status: 503 })
            : Response.json(mode === 'peer' ? { agentAddress: peer } : {})
          : responseFor(String(input)),
      );
      expect(await join(['--no-subscribe'])).toBe(0);
      expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe(
        'urn:dkg:agent:alice alice team',
      );
      if (mode !== 'missing') expect(warnings()).toContain('falling back to slug-based URI');
    },
  );
  it('prompts for a default slug and confirmation, closing both readers', async () => {
    const result = runCli(['join', 'team', `--workspace=${workspace}`, '--no-subscribe']);
    await vi.runAllTimersAsync();
    expect(await result).toBe(0);
    expect(question.mock.calls[0][0]).toContain('[alice-laptop]');
    expect(question.mock.calls[1][0]).toContain('1 file write?');
    expect(close).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('alice-laptop');
  });
  it('honors a declined multi-file confirmation without writing', async () => {
    manifest.publishedBy = 'urn:curator';
    manifest.claudeHooksTemplate = template('{}');
    question.mockResolvedValueOnce('custom-agent').mockResolvedValueOnce('n');
    expect(await runCli(['join', 'team', `--workspace=${workspace}`, '--no-subscribe'])).toBe(0);
    expect(question.mock.calls[1][0]).toContain('2 file writes?');
    expect(close).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });
  it('requires a slug for unattended installation', async () => {
    expect(
      await runCli(['join', 'team', `--workspace=${workspace}`, '--yes', '--no-subscribe']),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('agent slug required'));
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
  it('keeps Claude settings untouched when explicitly skipped', async () => {
    manifest.claudeHooksTemplate = template('{"hooks":{}}');
    const file = path.join(home, '.claude/settings.json');
    write(file, '{"theme":"keep"}');
    expect(await join(['--no-subscribe', '--skip-claude'])).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"keep"}');
    expect(output()).toContain('--skip-claude set');
  });
  it.each(['foreign', 'matching', 'no-hooks', 'invalid'] as const)(
    'reviews %s Claude wiring before making changes',
    async (mode) => {
      manifest.claudeHooksTemplate = template('{"hooks":{}}');
      const file = path.join(home, '.claude/settings.json');
      const command =
        mode === 'matching'
          ? `DKG_WORKSPACE=${workspace} DKG_AGENT_URI=urn:dkg:agent:${wallet.toLowerCase()} run-hook`
          : 'DKG_WORKSPACE=/different DKG_AGENT_URI=urn:other run-hook';
      const original =
        mode === 'invalid'
          ? '{broken'
          : JSON.stringify(mode === 'no-hooks' ? {} : { hooks: { Stop: [{ command }] } });
      write(file, original);
      expect(await join(['--no-subscribe', '--dry-run'])).toBe(0);
      expect(output().includes('will REPLACE')).toBe(mode === 'foreign');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    },
  );
  it('reports a real write error without claiming installation succeeded', async () => {
    fs.mkdirSync(path.join(workspace, 'AGENTS.md'));
    expect(await join(['--no-subscribe'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[join] write failed:'));
    expect(output()).not.toContain('✔ Installed');
  });
});

describe('status', () => {
  it('shows pinned membership and both present and missing workspace files', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    write(path.join(home, '.dkg/config.yaml'), 'project: team\nnode:\n  token: from-config\n');
    write(path.join(workspace, 'AGENTS.md'), 'instructions');
    expect(await runCli(['status', '--daemon=http://status.test:9876'])).toBe(0);
    expect(fetcher.mock.calls[0]).toEqual([
      'http://status.test:9876/api/context-graph/list',
      expect.objectContaining({ headers: { Authorization: 'Bearer from-config' } }),
    ]);
    expect(output()).toContain('team ★');
    expect(output()).toContain('other');
    expect(output()).toContain('✔ AGENTS.md');
    expect(output()).toContain('✘ .cursor/mcp.json');
  });
  it('reports unavailable daemon without checking workspace files', async () => {
    fetcher.mockRejectedValue(new Error('connection refused'));
    expect(await runCli(['status', '--token=provided'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith('  ✘ unreachable: connection refused');
    expect(output()).not.toContain('Workspace install state');
  });
});

it('defaults to the current workspace, leaves an absent Claude hook alone and reports plural installs', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  manifest.configTemplate = template('project: {{contextGraphId}}');
  const result = runCli(['join', 'team', '--agent-slug=alice', '--yes', '--skip-claude']);
  await vi.runAllTimersAsync();
  expect(await result).toBe(0);
  expect(fs.readFileSync(path.join(workspace, '.dkg/config.yaml'), 'utf8')).toBe('project: team');
  expect(output()).toContain('Installed 2 files');
  expect(warnings()).not.toContain('--skip-claude set');
});

it('detects a conflicting existing Claude hook when daemon identity falls back to the slug', async () => {
  manifest.claudeHooksTemplate = template('{}');
  write(
    path.join(home, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ command: 'DKG_WORKSPACE=/old DKG_AGENT_URI=urn:dkg:agent:old run-hook' }] },
        ],
      },
    }),
  );
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/api/agent/identity') ? Response.json({}) : responseFor(String(url)),
  );
  expect(await join(['--dry-run'])).toBe(0);
  expect(output()).toContain('will REPLACE them');
  expect(output()).toContain('installing as "urn:dkg:agent:alice"');
});
