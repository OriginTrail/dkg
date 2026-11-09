import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, describeConfig } from '../src/config.js';
let root: string;
function write(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-boundaries-'));
  for (const key of [
    'DKG_HOME',
    'DKG_API',
    'DKG_TOKEN',
    'DEVNET_API',
    'DEVNET_TOKEN',
    'DKG_AUTH',
    'DKG_PROJECT',
    'DKG_AGENT_URI',
  ])
    vi.stubEnv(key, undefined);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace configuration boundaries', () => {
  it('finds the nearest ancestor config and uses environment defaults outside a workspace', () => {
    vi.stubEnv('DKG_PROJECT', 'fallback');
    vi.stubEnv('DKG_AUTH', 'env-auth');
    expect(loadConfig(root)).toMatchObject({
      defaultProject: 'fallback',
      sourcePath: null,
      token: 'env-auth',
    });
    write(path.join(root, '.dkg/config.yaml'), 'project: ancestor\n');
    write(path.join(root, 'child/.dkg/config.yaml'), 'contextGraph: closest\n');
    expect(loadConfig(path.join(root, 'child/nested'))).toMatchObject({
      defaultProject: 'closest',
      sourcePath: path.join(root, 'child/.dkg/config.yaml'),
    });
  });
  it.each([
    {
      scenario: 'relative path',
      tokenPath: () => '../auth.token',
      tokenFileContents: '# comment\n\n  secret-token  \nsecond-token\n',
      expectedToken: 'secret-token',
    },
    {
      scenario: 'absolute path',
      tokenPath: (home: string) => path.join(home, 'auth.token'),
      tokenFileContents: '# comment\n\n  secret-token  \nsecond-token\n',
      expectedToken: 'secret-token',
    },
    {
      scenario: 'home-relative path',
      tokenPath: () => '~/auth.token',
      tokenFileContents: '# comment\n\n  secret-token  \nsecond-token\n',
      expectedToken: 'secret-token',
    },
    {
      scenario: 'bare home path points to a directory',
      tokenPath: () => '~',
      tokenFileContents: undefined,
      expectedToken: 'fallback-token',
    },
    {
      scenario: 'missing token file',
      tokenPath: (home: string) => path.join(home, 'auth.token'),
      tokenFileContents: undefined,
      expectedToken: 'fallback-token',
    },
    {
      scenario: 'empty token file',
      tokenPath: (home: string) => path.join(home, 'auth.token'),
      tokenFileContents: '',
      expectedToken: 'fallback-token',
    },
    {
      scenario: 'comment-only token file',
      tokenPath: (home: string) => path.join(home, 'auth.token'),
      tokenFileContents: '# no token\n\n',
      expectedToken: 'fallback-token',
    },
  ])('resolves $scenario without leaking credentials into diagnostics', (fixture) => {
    if (fixture.tokenFileContents !== undefined)
      write(path.join(root, 'auth.token'), fixture.tokenFileContents);
    write(
      path.join(root, '.dkg/config.yaml'),
      JSON.stringify({ node: { tokenFile: fixture.tokenPath(root) } }),
    );
    vi.stubEnv('DKG_TOKEN', 'fallback-token');

    const config = loadConfig(root);
    expect(config.token).toBe(fixture.expectedToken);
    const summary = describeConfig(config);
    expect(summary).toContain('token=[set]');
    expect(summary).not.toContain(config.token);
  });

  it.each([true, false, ' TRUE ', 'false', 12])(
    'honors capture preferences and explicit top-level autoShare %j',
    (autoShare) => {
      write(
        path.join(root, '.dkg/config.yaml'),
        JSON.stringify({
          autoShare,
          node: { api: 'http://file:1234', token: 'literal' },
          agent: { uri: 'urn:alice' },
          capture: {
            autoShare: false,
            privacy: 'private',
            subGraph: 'notes',
            assertion: 'session',
          },
        }),
      );
      const config = loadConfig(root);
      expect(config).toMatchObject({
        api: 'http://file:1234',
        token: 'literal',
        agentUri: 'urn:alice',
        capture: {
          autoShare: autoShare === true || autoShare === ' TRUE ' || autoShare === 12,
          defaultPrivacy: 'private',
          subGraph: 'notes',
          assertion: 'session',
        },
      });
      expect(describeConfig(config)).toContain('agent=urn:alice');
    },
  );
  it.each(['public', 'team', 'unknown'])(
    'normalizes privacy %s and legacy capture preferences',
    (privacy) => {
      write(
        path.join(root, '.dkg/config.yaml'),
        JSON.stringify({ capture: { autoShare: false, defaultPrivacy: privacy } }),
      );
      expect(loadConfig(root).capture).toEqual({
        autoShare: false,
        defaultPrivacy: privacy === 'public' ? 'public' : 'team',
        subGraph: 'chat',
        assertion: 'chat-log',
      });
    },
  );
  it.each(['', 'null', '42', '{ broken', '{"node":3,"agent":"invalid","capture":false}'])(
    'falls back safely for unusable YAML %j',
    (raw) => {
      const sourcePath = path.join(root, '.dkg/config.yaml');
      write(sourcePath, raw);
      expect(loadConfig(root)).toMatchObject({
        api: 'http://localhost:9200',
        token: '',
        defaultProject: null,
        agentUri: null,
        sourcePath,
      });
      expect(describeConfig(loadConfig(root))).toContain('token=[empty]');
      if (raw === '{ broken')
        expect(process.stderr.write).toHaveBeenCalledWith(
          expect.stringContaining('warning: could not parse'),
        );
    },
  );
});

describe('daemon home translation', () => {
  it.each(['null', 'false', '{broken', '{"apiPort":"bad","contextGraphs":"bad"}'])(
    'uses safe defaults for %j without falling through to workspace YAML',
    (raw) => {
      vi.stubEnv('DKG_HOME', root);
      write(path.join(root, 'config.json'), raw);
      write(path.join(root, 'config.yaml'), 'project: wrong\n');
      expect(loadConfig(root)).toMatchObject({
        api: 'http://localhost:9200',
        defaultProject: null,
        token: '',
        sourcePath: path.join(root, 'config.json'),
      });
      if (raw === '{broken')
        expect(process.stderr.write).toHaveBeenCalledWith(
          expect.stringContaining('warning: could not parse'),
        );
    },
  );
  it.each(['', '# comment\n', '# comment\n\n daemon-token \n'])(
    'reads only a non-comment daemon token from %j',
    (token) => {
      vi.stubEnv('DKG_HOME', root);
      write(path.join(root, 'config.json'), '{"apiPort":9300,"contextGraphs":[42]}');
      write(path.join(root, 'auth.token'), token);
      expect(loadConfig(root)).toMatchObject({
        api: 'http://localhost:9300',
        token: token.includes('daemon-token') ? 'daemon-token' : '',
        defaultProject: null,
      });
    },
  );
});

it('terminates discovery at the filesystem root with environment-only defaults', () => {
  vi.stubEnv('DKG_PROJECT', 'env-project');
  expect(loadConfig(path.parse(root).root)).toMatchObject({
    defaultProject: 'env-project',
    sourcePath: null,
  });
});
