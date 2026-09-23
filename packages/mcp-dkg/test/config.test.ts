import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

/**
 * Tests for `loadConfig()`'s DKG_HOME precedence. Codex Round-11
 * Fix 18: when `DKG_HOME` is set, the loader reads
 * `<DKG_HOME>/config.yaml` directly (no cwd-walk fallback). When
 * `DKG_HOME` is unset, the existing cwd-walk for `.dkg/config.yaml`
 * is preserved as the spec-canonical workspace path.
 *
 * Round-9 Fix 16 propagates `DKG_HOME` into the MCP entry's `env`
 * field so spawned MCP servers (in GUI clients that don't inherit
 * shell env) read the same home setup just bootstrapped. Without
 * Fix 18, that propagation was inert at runtime — `loadConfig`
 * ignored `DKG_HOME`.
 */
describe('loadConfig — DKG_HOME precedence (Codex Round-11 Fix 18)', () => {
  let tmpRoot: string;
  let originalDkgHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-dkg-config-test-'));
    originalDkgHome = process.env.DKG_HOME;
    delete process.env.DKG_HOME;
    originalCwd = process.cwd();
  });

  afterEach(() => {
    if (originalDkgHome !== undefined) process.env.DKG_HOME = originalDkgHome;
    else delete process.env.DKG_HOME;
    try {
      process.chdir(originalCwd);
    } catch {
      // Best-effort restore — the original cwd may have been deleted by a
      // sibling test that used the same pattern. Leave the next test's
      // beforeEach to set its own working dir.
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Codex Round-11 Fix 18: DKG_HOME set + <DKG_HOME>/config.yaml exists → loads from there', () => {
    // Pre-fix: loadConfig ignored DKG_HOME entirely, only walking
    // `.dkg/config.yaml` from cwd. Round-9 Fix 16's `env: {
    // DKG_HOME }` propagation was inert at runtime. Post-fix: when
    // DKG_HOME is set, config is read from `<DKG_HOME>/config.yaml`
    // directly.
    const home = join(tmpRoot, 'fake-dkg-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'node:\n  api: http://x:9001\n',
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://x:9001');
    expect(cfg.sourcePath).toBe(join(home, 'config.yaml'));
  });

  it('Codex Round-11 Fix 18: DKG_HOME set + no config.yaml at that path → no fallback to cwd-walk', () => {
    // The no-fallback contract: when DKG_HOME is set explicitly,
    // a missing config.yaml at that path returns null
    // (sourcePath: null), NOT a silent fall-through to a cwd-walk.
    // Falling back would mask a missing-config issue and
    // re-introduce the cwd-dependence Fix 16 was meant to break.
    //
    // Setup: DKG_HOME=<empty dir>, then chdir into a workspace
    // that DOES have `.dkg/config.yaml`. Pre-fix, the cwd-walk
    // would have found and loaded the workspace config. Post-fix,
    // the empty DKG_HOME wins → sourcePath: null.
    const home = join(tmpRoot, 'empty-dkg-home');
    mkdirSync(home, { recursive: true });
    process.env.DKG_HOME = home;

    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(join(workspace, '.dkg'), { recursive: true });
    writeFileSync(
      join(workspace, '.dkg', 'config.yaml'),
      'node:\n  api: http://workspace:9999\n',
    );
    process.chdir(workspace);

    const cfg = loadConfig();
    // sourcePath null → no config file located.
    expect(cfg.sourcePath).toBeNull();
    // The workspace config was NOT silently loaded.
    expect(cfg.api).not.toBe('http://workspace:9999');
  });

  it('Codex Round-11 Fix 18: DKG_HOME unset → existing cwd-walk for .dkg/config.yaml preserved', () => {
    // Regression guard for the spec-canonical workspace path. With
    // DKG_HOME unset, walking upwards from cwd looking for
    // `.dkg/config.yaml` MUST still work.
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(join(workspace, '.dkg'), { recursive: true });
    writeFileSync(
      join(workspace, '.dkg', 'config.yaml'),
      'node:\n  api: http://workspace:9999\n',
    );
    process.chdir(workspace);

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://workspace:9999');
    expect(realpathSync(cfg.sourcePath!)).toBe(realpathSync(join(workspace, '.dkg', 'config.yaml')));
  });

  it('Codex Round-11 Fix 18: round-trip — mcp-setup-style env propagation reads from the bootstrapped home', () => {
    // Integration check: simulate what happens when a GUI client
    // spawns the registered MCP entry. `dkg mcp setup` (Round-9
    // Fix 16) writes `env: { DKG_HOME }` into the MCP entry; the
    // client's spawn injects DKG_HOME into the server process's
    // env; the server's loadConfig then reads from <DKG_HOME>.
    // This tests that whole loop works end-to-end inside
    // loadConfig's own contract.
    const setupHome = join(tmpRoot, 'setup-home');
    mkdirSync(setupHome, { recursive: true });
    // `project` is a TOP-LEVEL field per loadConfig's contract
    // (`fromFile.contextGraph` || `fromFile.project`); only `api`
    // and `token` are nested under `node`.
    writeFileSync(
      join(setupHome, 'config.yaml'),
      'node:\n  api: http://setup:9100\nproject: setup-project\n',
    );
    // Simulate the spawn-time env injection.
    process.env.DKG_HOME = setupHome;

    // chdir somewhere unrelated to verify cwd is not consulted.
    process.chdir(tmpRoot);

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://setup:9100');
    expect(cfg.defaultProject).toBe('setup-project');
    expect(cfg.sourcePath).toBe(join(setupHome, 'config.yaml'));
  });

  // ── Codex Round-21 Fix 27: translate setup-home daemon config ──

  it('Codex Round-21 Fix 27: DKG_HOME + setup-home config.json + auth.token → translates to DkgConfig (api / token / defaultProject)', async () => {
    // Round-19 Fix 25 incorrectly tried to parse <DKG_HOME>/
    // config.json as workspace-shape yaml. The shapes are
    // different — daemon config has `apiPort` / `contextGraphs` /
    // `auth: { enabled }`, NOT `node.api` / `node.token` /
    // `project` — so every extracted field fell through to env
    // defaults and the GUI-spawned MCP server returned empty
    // token + localhost:9200 + null project despite the FIX 16 →
    // FIX 18 → FIX 25 chain. Round-21 Fix 27 replaces the
    // mistranslation with a real translator: `api` derived from
    // `apiPort`, `token` from <DKG_HOME>/auth.token's first non-
    // comment line, `defaultProject` from `contextGraphs[0]`.
    const home = join(tmpRoot, 'setup-home');
    mkdirSync(home, { recursive: true });
    // Write a daemon config in the actual shape that
    // `dkg mcp setup`'s writeDkgConfig produces.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        name: 'mcp-agent-test',
        apiPort: 9001,
        nodeRole: 'edge',
        contextGraphs: ['my-ctx'],
        auth: { enabled: true },
      }),
    );
    // And the dedicated auth.token file (the real source of the
    // bearer token — NOT the daemon config).
    writeFileSync(join(home, 'auth.token'), 'my-token\n');
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    // api derived from apiPort.
    expect(cfg.api).toBe('http://localhost:9001');
    // token from auth.token file (one non-comment line).
    expect(cfg.token).toBe('my-token');
    // defaultProject from contextGraphs[0].
    expect(cfg.defaultProject).toBe('my-ctx');
    // sourcePath points at the JSON for diagnostics.
    expect(cfg.sourcePath).toBe(join(home, 'config.json'));
  });

  it('Codex Round-21 Fix 27: auth.token with comment lines + token → token correctly extracted', async () => {
    // The auth.token file format allows `#`-prefixed comment
    // lines (mirrors the existing resolveTokenFromFile helper).
    // Pin that the translator skips comments and picks the first
    // real non-empty line.
    const home = join(tmpRoot, 'commented-token-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ apiPort: 9200, contextGraphs: ['ctx'] }),
    );
    writeFileSync(
      join(home, 'auth.token'),
      '# auto-generated by dkg mcp setup\n# do not edit\nreal-token-here\n',
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.token).toBe('real-token-here');
  });

  it('Codex Round-21 Fix 27: auth.token missing + DKG_HOME has config.json → token is empty string (graceful)', async () => {
    // No crash when auth.token is missing — just empty token.
    // Operators on fully-open dev setups (or pre-auth installs)
    // hit this case naturally.
    const home = join(tmpRoot, 'no-token-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ apiPort: 9200, contextGraphs: [] }),
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.token).toBe('');
    expect(cfg.defaultProject).toBeNull();
  });

  it('Codex Round-21 Fix 27: DKG_HOME set + DKG_TOKEN env var set → env wins (operator override)', async () => {
    // Operator-precedence contract: env vars override file
    // values. An operator who sets `DKG_TOKEN=...` from their
    // shell wants that to win, regardless of what's at the home.
    const home = join(tmpRoot, 'env-override-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ apiPort: 9200, contextGraphs: [] }),
    );
    writeFileSync(join(home, 'auth.token'), 'file-token\n');
    process.env.DKG_HOME = home;
    process.env.DKG_TOKEN = 'env-token';
    try {
      const cfg = loadConfig();
      expect(cfg.token).toBe('env-token');
    } finally {
      delete process.env.DKG_TOKEN;
    }
  });

  it('Codex Round-21 Fix 27: DKG_HOME + only config.yaml (no config.json) → falls back to yaml (Path B)', async () => {
    // Round-11 Fix 18's original yaml-only contract preserved.
    // When the operator hand-writes a workspace-shape
    // <DKG_HOME>/config.yaml without going through
    // `dkg mcp setup`, loadConfig falls through to the regular
    // yaml-parse path (loadConfigFromDkgHome returns null →
    // findConfigFile picks up the yaml).
    const home = join(tmpRoot, 'yaml-only-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'node:\n  api: http://yaml:9300\n',
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://yaml:9300');
    expect(cfg.sourcePath).toBe(join(home, 'config.yaml'));
  });

  // A YAML-configured node: the daemon reads <DKG_HOME>/config.yaml, and
  // `dkg mcp setup` (like every config writer) keeps it in YAML rather than
  // adding a shadowing config.json. The server must translate it exactly as
  // it translates config.json — otherwise it runs with an empty token and
  // the default port.
  it('DKG_HOME + daemon-shaped config.yaml (YAML-configured node) → translated like config.json', () => {
    const home = join(tmpRoot, 'yaml-daemon-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'name: yaml-node',
        'networkConfig: testnet',
        'apiPort: 9317',
        'nodeRole: edge',
        'contextGraphs:',
        '  - yaml-ctx',
        'auth:',
        '  enabled: true',
        '',
      ].join('\n'),
    );
    writeFileSync(join(home, 'auth.token'), '# node token\nyaml-token\n');
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://localhost:9317');
    expect(cfg.token).toBe('yaml-token');
    expect(cfg.defaultProject).toBe('yaml-ctx');
    expect(cfg.sourcePath).toBe(join(home, 'config.yaml'));
  });

  it('DKG_HOME + config.json and a daemon-shaped config.yaml → config.json still wins', () => {
    const home = join(tmpRoot, 'both-files-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ apiPort: 9001, contextGraphs: ['json-ctx'] }));
    writeFileSync(join(home, 'config.yaml'), 'apiPort: 9317\ncontextGraphs:\n  - yaml-ctx\n');
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://localhost:9001');
    expect(cfg.defaultProject).toBe('json-ctx');
    expect(cfg.sourcePath).toBe(join(home, 'config.json'));
  });

  it('DKG_HOME + config.yaml with a workspace `node` block stays on the workspace path', () => {
    // A daemon config never has a `node` block, so a file that does is a
    // hand-written workspace config, even if it also names a daemon key.
    const home = join(tmpRoot, 'workspace-shape-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.yaml'), 'node:\n  api: http://yaml:9300\napiPort: 9317\n');
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://yaml:9300');
    expect(cfg.sourcePath).toBe(join(home, 'config.yaml'));
  });

  it('DKG_HOME + config.yaml that is malformed or not a mapping → workspace path, as before', () => {
    const home = join(tmpRoot, 'odd-yaml-home');
    mkdirSync(home, { recursive: true });
    process.env.DKG_HOME = home;
    const stderr = process.stderr.write;
    const warnings: string[] = [];
    process.stderr.write = ((chunk: string) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      writeFileSync(join(home, 'config.yaml'), 'apiPort: [unclosed\n');
      expect(loadConfig()).toMatchObject({ api: 'http://localhost:9200', sourcePath: join(home, 'config.yaml') });
      expect(warnings.join('')).toContain('could not parse');

      writeFileSync(join(home, 'config.yaml'), '- apiPort\n- 9317\n');
      expect(loadConfig()).toMatchObject({ api: 'http://localhost:9200', sourcePath: join(home, 'config.yaml') });
    } finally {
      process.stderr.write = stderr;
    }
  });

  it('Codex Round-21 Fix 27: DKG_HOME + neither file exists → sourcePath null + env defaults preserved', async () => {
    // Behavior preserved from Round-11 Fix 18: empty home →
    // sourcePath null + defaults. No crash, no cwd-walk.
    const home = join(tmpRoot, 'empty-home');
    mkdirSync(home, { recursive: true });
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.sourcePath).toBeNull();
    expect(cfg.api).toBe('http://localhost:9200');
  });
});
