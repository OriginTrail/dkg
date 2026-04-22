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

interface WorkspaceConfig {
  contextGraph: string;
  node: string;
  autoShare: boolean;
  extractionPolicy: string;
}

// Reference loader implementing the spec §22 schema. This mirrors what
// the agent layer SHOULD ship — see SPEC-GAP test below.
function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('workspace config: root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const contextGraph = obj.contextGraph;
  const node = obj.node;
  if (typeof contextGraph !== 'string' || contextGraph.length === 0) {
    throw new Error('workspace config: `contextGraph` is required (string)');
  }
  if (typeof node !== 'string' || node.length === 0) {
    throw new Error('workspace config: `node` is required (string)');
  }
  const autoShare = obj.autoShare ?? true;
  if (typeof autoShare !== 'boolean') {
    throw new Error('workspace config: `autoShare` must be boolean');
  }
  const extractionPolicy = (obj.extractionPolicy as string | undefined) ?? 'structural-plus-semantic';
  if (!EXTRACTION_POLICIES.has(extractionPolicy)) {
    throw new Error(
      `workspace config: \`extractionPolicy\` must be one of ${[...EXTRACTION_POLICIES].join(', ')}`,
    );
  }
  return { contextGraph, node, autoShare, extractionPolicy };
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function parseAgentsMdFrontmatter(src: string): WorkspaceConfig {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) throw new Error('AGENTS.md: missing YAML frontmatter');
  const fm = yaml.load(m[1]) as Record<string, unknown> | null;
  if (!fm || typeof fm !== 'object' || !('dkg' in fm)) {
    throw new Error('AGENTS.md frontmatter: missing `dkg` key');
  }
  return parseWorkspaceConfig(fm.dkg);
}

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
      node: 'http://127.0.0.1:9201',
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
      node: 'http://n',
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
    expect(cfg.node).toBe('http://127.0.0.1:9201');
    expect(cfg.autoShare).toBe(true);
  });

  it('rejects AGENTS.md with no frontmatter', () => {
    const md = '# just a heading\n';
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/frontmatter/);
  });

  it('rejects AGENTS.md frontmatter missing `dkg:` key', () => {
    const md = ['---', 'title: foo', '---', '# body'].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/dkg/);
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
});

describe('A-13: SPEC-GAP — `packages/agent/src` ships no workspace-config loader', () => {
  // PROD-BUG / SPEC-GAP: spec §22 requires agents to auto-discover their
  // configuration from `.dkg/config.yaml` and friends. Today, the agent
  // package exposes no loader module — see BUGS_FOUND.md A-13. This test
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
      'packages/agent/src has no workspace-config.ts / onboarding.ts module (BUGS_FOUND.md A-13)',
    ).toBe(true);
  });
});
