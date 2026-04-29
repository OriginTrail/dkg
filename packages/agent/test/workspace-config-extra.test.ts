/**
 * Workspace configuration (`.dkg/config.yaml`) parsing + onboarding flow
 * pins, per dkgv10-spec/22_AGENT_ONBOARDING.md.
 *
 * Audit findings covered:
 *   A-13 (MEDIUM / SPEC-GAP) — the agent layer has no production code path
 *        that reads `.dkg/config.yaml` / `AGENTS.md` frontmatter and feeds
 *        it into `DKGAgent`. This is a pending onboarding feature. Until
 *        the feature lands, this file acts as the schema contract test:
 *
 *          1. Positive: valid YAML loads and satisfies the schema.
 *          2. Positive: `.dkg/config.json` fallback (priority 2) parses.
 *          3. Positive: AGENTS.md frontmatter (priority 3) parses.
 *          4. Negative: missing `contextGraph` is a schema error.
 *          5. Negative: missing `node` is a schema error.
 *          6. Negative: invalid `extractionPolicy` is rejected.
 *          7. SPEC-GAP: `packages/agent/src` ships no workspace-config
 *             loader module (no `workspace-config.ts`, no `loadConfig`
 *             export). Left RED so the gap is visible.
 *
 * No mocks — real `js-yaml` + filesystem + a hermetic tmpdir.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTRACTION_POLICIES = new Set([
  'structural-only',
  'structural-plus-semantic',
  'semantic-required',
]);

interface WorkspaceConfigNode {
  api: string;
  tokenFile?: string;
  token?: string;
}

interface WorkspaceConfig {
  contextGraph: string;
  // r31-6: the schema now
  // normalises `node:` to a structured object (`{api, tokenFile?,
  // token?}`). The bare-string form is still accepted as input (and is
  // normalised to `{api: <string>}`) so existing configs keep working,
  // but every consumer must treat `cfg.node` as an object on the way
  // out. Match the production type exactly so this suite catches drift.
  node: WorkspaceConfigNode;
  autoShare: boolean;
  extractionPolicy: string;
}

// the suite originally shipped a LOCAL reference
// loader to keep the schema test green even before the production
// module landed (see SPEC-GAP test below). The production
// `workspace-config.ts` now exports the same surface AND has been
// extended (r21-4 / r22-5) to accept plain-Markdown AGENTS.md via a
// `dkg-config` fence. Re-bind the test names to the production
// exports so this suite actually exercises the shipping behaviour;
// otherwise our regression tests would pass against the local stub
// while the real code regresses unobserved.
import {
  parseWorkspaceConfig as parseWorkspaceConfigImpl,
  parseAgentsMdFrontmatter as parseAgentsMdFrontmatterImpl,
} from '../src/workspace-config.js';
const parseWorkspaceConfig = parseWorkspaceConfigImpl as unknown as (raw: unknown) => WorkspaceConfig;
const parseAgentsMdFrontmatter = parseAgentsMdFrontmatterImpl as unknown as (src: string) => WorkspaceConfig;

describe('A-13: workspace config schema (.dkg/config.yaml)', () => {
  it('parses a spec-compliant YAML with all fields', () => {
    const src = [
      'contextGraph: "my-project"',
      'node: "http://127.0.0.1:9201"',
      'autoShare: true',
      'extractionPolicy: "structural-plus-semantic"',
      '',
    ].join('\n');

    const cfg = parseWorkspaceConfig(yaml.load(src));
    expect(cfg).toEqual({
      contextGraph: 'my-project',
      // bare-string `node:` normalises to `{ api: <string> }`.
      node: { api: 'http://127.0.0.1:9201' },
      autoShare: true,
      extractionPolicy: 'structural-plus-semantic',
    });
  });

  it('applies defaults (autoShare=true, extractionPolicy=structural-plus-semantic)', () => {
    const src = [
      'contextGraph: "proj"',
      'node: "http://127.0.0.1:9201"',
    ].join('\n');
    const cfg = parseWorkspaceConfig(yaml.load(src));
    expect(cfg.autoShare).toBe(true);
    expect(cfg.extractionPolicy).toBe('structural-plus-semantic');
  });

  it('allows autoShare=false', () => {
    const src = [
      'contextGraph: "p"',
      'node: "http://n"',
      'autoShare: false',
    ].join('\n');
    const cfg = parseWorkspaceConfig(yaml.load(src));
    expect(cfg.autoShare).toBe(false);
  });

  it('rejects config missing `contextGraph`', () => {
    const src = 'node: "http://127.0.0.1:9201"';
    expect(() => parseWorkspaceConfig(yaml.load(src))).toThrow(/contextGraph/);
  });

  it('rejects config missing `node`', () => {
    const src = 'contextGraph: "p"';
    expect(() => parseWorkspaceConfig(yaml.load(src))).toThrow(/node/);
  });

  it('rejects config with unsupported `extractionPolicy`', () => {
    const src = [
      'contextGraph: "p"',
      'node: "http://n"',
      'extractionPolicy: "bogus"',
    ].join('\n');
    expect(() => parseWorkspaceConfig(yaml.load(src))).toThrow(/extractionPolicy/);
  });

  it('rejects non-boolean `autoShare`', () => {
    const src = [
      'contextGraph: "p"',
      'node: "http://n"',
      'autoShare: "yes"',
    ].join('\n');
    expect(() => parseWorkspaceConfig(yaml.load(src))).toThrow(/autoShare/);
  });
});

describe('A-13: alternative config locations', () => {
  it('parses `.dkg/config.json` (priority 2)', () => {
    const raw = JSON.parse(
      '{"contextGraph":"p","node":"http://n","autoShare":false,"extractionPolicy":"structural-only"}',
    );
    const cfg = parseWorkspaceConfig(raw);
    expect(cfg).toEqual({
      contextGraph: 'p',
      // bare-string `node:` normalises to `{ api: <string> }`.
      node: { api: 'http://n' },
      autoShare: false,
      extractionPolicy: 'structural-only',
    });
  });

  it('parses AGENTS.md frontmatter (priority 3)', () => {
    const md = [
      '---',
      'dkg:',
      '  contextGraph: "my-project"',
      '  node: "http://127.0.0.1:9201"',
      '  autoShare: true',
      '---',
      '',
      '# Project Agents',
      '',
      'This project uses DKG shared memory.',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('my-project');
    // bare-string `node:` normalises to `{ api: <string> }`.
    expect(cfg.node).toEqual({ api: 'http://127.0.0.1:9201' });
    expect(cfg.autoShare).toBe(true);
  });

  it('rejects AGENTS.md with no frontmatter AND no dkg-config fence', () => {
    const md = '# just a heading\n';
    // the diagnostic now mentions BOTH
    // carriers because we tried both before failing.
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(
      /frontmatter|dkg-config/,
    );
  });

  it('rejects AGENTS.md frontmatter missing `dkg:` key when no fence is present either', () => {
    const md = ['---', 'title: foo', '---', '# body'].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/dkg/);
  });

  // the AGENTS.md convention used
  // by Cursor / Continue / Codex CLI is plain Markdown WITHOUT
  // frontmatter. The code threw "missing YAML frontmatter"
  // and the documented third lookup tier was therefore unusable for
  // the projects that actually rely on it as a workspace-config
  // carrier. The fenced ```dkg-config``` block is the supported
  // alternate carrier.
  it('parses plain-Markdown AGENTS.md via a ```dkg-config``` fence', () => {
    const md = [
      '# Project Agents',
      '',
      'This project uses DKG shared memory.',
      '',
      '```dkg-config',
      'contextGraph: "fence-only"',
      'node: "http://127.0.0.1:9201"',
      'autoShare: false',
      '```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('fence-only');
    // bare-string `node:` normalises to `{ api: <string> }`.
    expect(cfg.node).toEqual({ api: 'http://127.0.0.1:9201' });
    expect(cfg.autoShare).toBe(false);
  });

  it('also accepts ```yaml dkg-config``` and ```json dkg-config``` info-string variants', () => {
    const yml = [
      '# header',
      '```yaml dkg-config',
      'contextGraph: "yaml-fence"',
      'node: "http://n"',
      '```',
    ].join('\n');
    expect(parseAgentsMdFrontmatter(yml).contextGraph).toBe('yaml-fence');

    const json = [
      '# header',
      '```json dkg-config',
      '{ "contextGraph": "json-fence", "node": "http://n" }',
      '```',
    ].join('\n');
    expect(parseAgentsMdFrontmatter(json).contextGraph).toBe('json-fence');
  });

  // the
  // previous frontmatter regex required a trailing newline AFTER the
  // closing `---`, so a valid AGENTS.md whose frontmatter block was
  // the entire file (no trailing body, no final newline) would never
  // match and fall through to the "no carrier found" diagnostic.
  // Lock in that frontmatter at EOF works.
  it('parses frontmatter that is the whole file (no trailing newline)', () => {
    const md = '---\ndkg:\n  contextGraph: "eof-fm"\n  node: "http://n"\n---';
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('eof-fm');
  });

  it('parses frontmatter that ends right at EOF with a trailing CR', () => {
    const md = '---\r\ndkg:\r\n  contextGraph: "eof-cr"\r\n  node: "http://n"\r\n---\r\n';
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('eof-cr');
  });

  // the previous mega-regex could backtrack super-linearly on inputs
  // with many candidate `\n` start positions. The new line-by-line
  // scan must remain linear; we exercise a few edge cases the lazy
  // regex would have hit hardest.
  it('ignores fence-shaped lines that do not match the dkg-config info-string', () => {
    const md = [
      '# header',
      '```bash',
      'echo not-our-fence',
      '```',
      '',
      '```dkg-config',
      'contextGraph: "after-decoy"',
      'node: "http://n"',
      '```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('after-decoy');
  });

  // ───────────────────────────────────────────────────────────────────
  // workspace-config.ts:130). The
  // pre-fix open/close fence regexes required column-0 anchors, so a
  // legitimate `dkg-config` block under a list item, a blockquote, or
  // emitted by a Markdown formatter that normalised indentation was
  // ignored. CommonMark allows up to 3 leading spaces on fence lines —
  // anything from 4+ becomes an indented code block, not a fenced one.
  // These tests pin: (1) 0–3 leading spaces are accepted, (2) 4+ are
  // still rejected (because they're indented code blocks), (3) a tab-
  // indented fence is rejected (CommonMark only allows spaces here).
  // ───────────────────────────────────────────────────────────────────
  it('parses a `dkg-config` fence with 1 leading space (CommonMark indented-fence form)', () => {
    const md = [
      '- list item',
      ' ```dkg-config',
      ' contextGraph: "indented-1"',
      ' node: "http://n"',
      ' ```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('indented-1');
  });

  it('parses a `dkg-config` fence with 2 leading spaces', () => {
    const md = [
      '> blockquote',
      '  ```dkg-config',
      '  contextGraph: "indented-2"',
      '  node: "http://n"',
      '  ```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('indented-2');
  });

  it('parses a `dkg-config` fence with 3 leading spaces (the CommonMark maximum)', () => {
    const md = [
      '   ```dkg-config',
      '   contextGraph: "indented-3"',
      '   node: "http://n"',
      '   ```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('indented-3');
  });

  it('REJECTS a `dkg-config` fence with 4 leading spaces (CommonMark indented code block boundary)', () => {
    // 4+ leading spaces is an indented code block per CommonMark §4.4,
    // not a fenced one. The loader must NOT match this as a fence.
    const md = [
      '# header',
      '    ```dkg-config',
      '    contextGraph: "should-not-load"',
      '    node: "http://n"',
      '    ```',
    ].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/no workspace config found/i);
  });

  it('REJECTS a `dkg-config` fence indented by tabs (CommonMark fence indent grammar is space-only)', () => {
    const md = [
      '# header',
      '\t```dkg-config',
      '\tcontextGraph: "tab-indent"',
      '\tnode: "http://n"',
      '\t```',
    ].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/no workspace config found/i);
  });

  it('still requires the close fence to be present and CommonMark-indented (close fence at column 0 with open at +2 still works)', () => {
    // Real-world Markdown often has the open fence indented (under a
    // list / blockquote) and the close fence in column 0 (or vice
    // versa). The loader must accept ANY 0-3-space indent on EITHER
    // fence independently.
    const md = [
      '- list item',
      '  ```dkg-config',
      '  contextGraph: "mixed-indent"',
      '  node: "http://n"',
      '```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('mixed-indent');
  });

  it('an unterminated dkg-config fence falls through to the "no carrier" error', () => {
    const md = [
      '# header',
      '',
      '```dkg-config',
      'contextGraph: "never-closed"',
      'node: "http://n"',
      // intentionally no closing ```
    ].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/no workspace config found/i);
  });

  // when AGENTS.md has unrelated
  // frontmatter (extremely common for tags/owner/prompt metadata in
  // the AI-agent ecosystem) but the dkg config lives in a fenced
  // block below, the loader MUST fall through to the fence parser
  // instead of throwing on the missing top-level `dkg:` key.
  it('falls through to fence when frontmatter exists but lacks `dkg:` key', () => {
    const md = [
      '---',
      'title: project notes',
      'owner: alice',
      '---',
      '',
      '# Notes',
      '',
      '```dkg-config',
      'contextGraph: "fallthrough-cg"',
      'node: "http://n"',
      '```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('fallthrough-cg');
  });

  // before the fix, frontmatter that yaml.load() rejected (a
  // tab-indented block, a custom tag, an unsupported syntax) would
  // throw out of parseAgentsMdFrontmatter() before the fence
  // parser ran, breaking the multi-tool case the fence fallback
  // was added to support. Lock the new behaviour: a YAML parse
  // error in frontmatter must NOT abort the loader — control
  // continues into the fence parser, and only after both carriers
  // have been considered do we throw the "no workspace config
  // found" diagnostic.
  it('falls through to fence when frontmatter is unparseable YAML', () => {
    const md = [
      '---',
      // Frontmatter whose body is intentionally invalid YAML (a
      // bare colon at column 0 with no key). js-yaml rejects this.
      ': not valid yaml',
      '\t- with: tab indentation',
      '   broken: [unclosed',
      '---',
      '',
      '# Notes',
      '',
      '```dkg-config',
      'contextGraph: "yaml-error-fallthrough"',
      'node: "http://n"',
      '```',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('yaml-error-fallthrough');
  });

  // Companion test: when frontmatter is unparseable AND no fence
  // exists, the user gets the canonical "no carrier found"
  // diagnostic — NOT the js-yaml internal parse error, which leaks
  // implementation detail and doesn't tell the user what to add.
  it('unparseable frontmatter + no fence yields the canonical "no carrier" diagnostic', () => {
    const md = [
      '---',
      ': not valid yaml',
      '   broken: [unclosed',
      '---',
      '',
      '# Notes — no dkg-config fence',
    ].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/no workspace config found/);
  });
});

describe('A-13: file-system priority resolution', () => {
  it('picks `.dkg/config.yaml` over `.dkg/config.json` over `AGENTS.md`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-ws-'));
    mkdirSync(join(dir, '.dkg'));
    writeFileSync(
      join(dir, '.dkg', 'config.yaml'),
      'contextGraph: "from-yaml"\nnode: "http://n"\n',
    );
    writeFileSync(
      join(dir, '.dkg', 'config.json'),
      JSON.stringify({ contextGraph: 'from-json', node: 'http://n' }),
    );
    writeFileSync(
      join(dir, 'AGENTS.md'),
      '---\ndkg:\n  contextGraph: "from-md"\n  node: "http://n"\n---\n',
    );

    // Minimal priority resolver implementing spec §2.1.
    function resolve(workspace: string): { source: string; cfg: WorkspaceConfig } {
      const yml = join(workspace, '.dkg', 'config.yaml');
      const jsn = join(workspace, '.dkg', 'config.json');
      const md = join(workspace, 'AGENTS.md');
      if (existsSync(yml)) return { source: yml, cfg: parseWorkspaceConfig(yaml.load(readFileSync(yml, 'utf8'))) };
      if (existsSync(jsn)) return { source: jsn, cfg: parseWorkspaceConfig(JSON.parse(readFileSync(jsn, 'utf8'))) };
      if (existsSync(md)) return { source: md, cfg: parseAgentsMdFrontmatter(readFileSync(md, 'utf8')) };
      throw new Error('no workspace config found');
    }

    function existsSync(p: string): boolean {
      try { statSync(p); return true; } catch { return false; }
    }

    const r = resolve(dir);
    expect(r.source.endsWith('.dkg/config.yaml')).toBe(true);
    expect(r.cfg.contextGraph).toBe('from-yaml');
  });

  // the agent's own
  // `loadWorkspaceConfig` MUST resolve plain-Markdown AGENTS.md (no
  // YAML frontmatter, fenced ```dkg-config``` block) so the
  // documented third lookup tier is actually usable on this very
  // monorepo (whose AGENTS.md is plain Markdown).
  it('loadWorkspaceConfig accepts plain-Markdown AGENTS.md with a dkg-config fence', async () => {
    const { loadWorkspaceConfig } = await import('../src/workspace-config.js');
    const dir = mkdtempSync(join(tmpdir(), 'dkg-ws-fence-'));
    writeFileSync(
      join(dir, 'AGENTS.md'),
      [
        '# Project Agents',
        '',
        'No frontmatter here, just a fenced block.',
        '',
        '```dkg-config',
        'contextGraph: "fence-only-via-load"',
        'node: "http://127.0.0.1:9201"',
        '```',
      ].join('\n'),
    );
    const r = loadWorkspaceConfig(dir);
    expect(r.source.endsWith('AGENTS.md')).toBe(true);
    expect(r.cfg.contextGraph).toBe('fence-only-via-load');
    // bare-string `node:` normalises to `{ api: <string> }`.
    expect(r.cfg.node).toEqual({ api: 'http://127.0.0.1:9201' });
  });

  // ───────────────────────────────────────────────────────────────────
  // The pre-fix
  // schema rejected the canonical `.dkg/config.yaml` shape (`node:` as
  // an object with `api`/`tokenFile`/...) — exactly the shape that
  // `mcp-dkg/config.yaml.example` ships and `mcp-dkg/src/config.ts`
  // reads. Pin: the loader MUST round-trip the canonical file end-to-
  // end, preserving `tokenFile` so downstream code can resolve auth.
  // ───────────────────────────────────────────────────────────────────
  it('loadWorkspaceConfig accepts the canonical `.dkg/config.yaml` shape (object node:)', async () => {
    const { loadWorkspaceConfig } = await import('../src/workspace-config.js');
    const dir = mkdtempSync(join(tmpdir(), 'dkg-ws-r316-'));
    mkdirSync(join(dir, '.dkg'));
    writeFileSync(
      join(dir, '.dkg', 'config.yaml'),
      [
        'contextGraph: dkg-code-project',
        'autoShare: true',
        '',
        'node:',
        '  api: http://localhost:9200',
        '  tokenFile: ../.devnet/node1/auth.token',
        '',
      ].join('\n'),
    );
    const r = loadWorkspaceConfig(dir);
    expect(r.source.endsWith('config.yaml')).toBe(true);
    expect(r.cfg.contextGraph).toBe('dkg-code-project');
    expect(r.cfg.node).toEqual({
      api: 'http://localhost:9200',
      tokenFile: '../.devnet/node1/auth.token',
    });
    expect(r.cfg.autoShare).toBe(true);
  });
});

describe('A-13: SPEC-GAP — `packages/agent/src` ships no workspace-config loader', () => {
  // PROD-BUG / SPEC-GAP: spec §22 requires agents to auto-discover their
  // configuration from `.dkg/config.yaml` and friends. Today, the agent
  // package exposes no loader module — This test
  // is intentionally RED: once a `workspace-config.ts` module lands that
  // exports a `loadWorkspaceConfig(workspaceDir)` function, it will go
  // green.
  it('exports a workspace config loader', () => {
    const srcDir = resolve(__dirname, '..', 'src');
    const entries = readdirSync(srcDir);
    const hasLoader = entries.some(n =>
      /workspace[-_]config\.(t|j)s$/i.test(n) ||
      /onboard(ing)?\.(t|j)s$/i.test(n),
    );
    expect(
      hasLoader,
      'packages/agent/src has no workspace-config.ts / onboarding.ts module',
    ).toBe(true);
  });
});
