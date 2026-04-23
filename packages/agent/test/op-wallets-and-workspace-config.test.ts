/**
 * Targeted coverage for two small agent modules that were almost entirely
 * untested:
 *   - op-wallets.ts           (5% → ~100%)
 *   - workspace-config.ts     (5% → ~100%)
 *
 * Both modules run against real FS + real ethers Wallets — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { loadOpWallets, generateWallets } from '../src/op-wallets.js';
import {
  parseWorkspaceConfig,
  parseAgentsMdFrontmatter,
  loadWorkspaceConfig,
} from '../src/workspace-config.js';

describe('op-wallets — loadOpWallets + generateWallets', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-opw-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generateWallets returns exactly `count` wallets, each valid ethers-derivable pair', () => {
    const cfg = generateWallets(5);
    expect(cfg.wallets).toHaveLength(5);
    for (const w of cfg.wallets) {
      const derived = new ethers.Wallet(w.privateKey);
      expect(derived.address.toLowerCase()).toBe(w.address.toLowerCase());
    }
    // Uniqueness — random wallet generation must not collide.
    const addrs = new Set(cfg.wallets.map(w => w.address));
    expect(addrs.size).toBe(5);
  });

  it('loadOpWallets creates wallets.json on first run with the default count', async () => {
    const out = await loadOpWallets(dir);
    expect(out.wallets).toHaveLength(3); // DEFAULT_WALLET_COUNT

    const raw = readFileSync(join(dir, 'wallets.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.wallets).toHaveLength(3);

    // POSIX 0o600 — the file MUST NOT be world-readable (private keys).
    const stat = statSync(join(dir, 'wallets.json'));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('loadOpWallets creates parent directory when missing (mkdir recursive)', async () => {
    const nested = join(dir, 'nested', 'path');
    const out = await loadOpWallets(nested, 2);
    expect(out.wallets).toHaveLength(2);
    expect(statSync(join(nested, 'wallets.json')).isFile()).toBe(true);
  });

  it('loadOpWallets is idempotent — second call returns the same wallets (file preserved)', async () => {
    const out1 = await loadOpWallets(dir, 4);
    const out2 = await loadOpWallets(dir, 4);
    expect(out2.wallets).toEqual(out1.wallets);
  });

  it('loadOpWallets re-validates each wallet — throws on address mismatch', async () => {
    const bogus = {
      wallets: [{
        address: '0xdeadbeef00000000000000000000000000000000', // does not derive from below key
        privateKey: '0x' + '1'.repeat(64),
      }],
    };
    writeFileSync(join(dir, 'wallets.json'), JSON.stringify(bogus));
    await expect(loadOpWallets(dir)).rejects.toThrow(/Address mismatch in wallets.json/);
  });

  it('loadOpWallets propagates read-errors other than ENOENT (invalid JSON → SyntaxError)', async () => {
    writeFileSync(join(dir, 'wallets.json'), 'this is not json');
    await expect(loadOpWallets(dir)).rejects.toThrow();
  });

  it('loadOpWallets regenerates when the file exists but wallets array is empty', async () => {
    // Empty wallets array → the `config.wallets?.length > 0` guard fails and
    // we fall through to the regenerate branch.
    writeFileSync(join(dir, 'wallets.json'), JSON.stringify({ wallets: [] }));
    const out = await loadOpWallets(dir, 2);
    expect(out.wallets).toHaveLength(2);
  });
});

describe('workspace-config — parseWorkspaceConfig (schema + defaults)', () => {
  it('requires contextGraph (string, non-empty) and node (string, non-empty)', () => {
    expect(() => parseWorkspaceConfig(null)).toThrow(/root must be an object/);
    expect(() => parseWorkspaceConfig('string')).toThrow(/root must be an object/);
    expect(() => parseWorkspaceConfig({ node: 'n' })).toThrow(/`contextGraph` is required/);
    expect(() => parseWorkspaceConfig({ contextGraph: '' })).toThrow(/`contextGraph` is required/);
    expect(() => parseWorkspaceConfig({ contextGraph: 'cg' })).toThrow(/`node` is required/);
    expect(() => parseWorkspaceConfig({ contextGraph: 'cg', node: '' })).toThrow(/`node` is required/);
    expect(() => parseWorkspaceConfig({ contextGraph: 'cg', node: 42 })).toThrow(/`node` is required/);
  });

  it('applies defaults: autoShare=true, extractionPolicy=structural-plus-semantic', () => {
    const out = parseWorkspaceConfig({ contextGraph: 'cg', node: 'n' });
    expect(out.autoShare).toBe(true);
    expect(out.extractionPolicy).toBe('structural-plus-semantic');
  });

  it('rejects non-boolean autoShare', () => {
    expect(() => parseWorkspaceConfig({
      contextGraph: 'cg', node: 'n', autoShare: 'yes',
    })).toThrow(/`autoShare` must be boolean/);
  });

  it('rejects unknown extractionPolicy values', () => {
    expect(() => parseWorkspaceConfig({
      contextGraph: 'cg', node: 'n', extractionPolicy: 'bogus',
    })).toThrow(/extractionPolicy.*must be one of/);
  });

  it('accepts all three documented extractionPolicy values', () => {
    for (const p of ['structural-only', 'structural-plus-semantic', 'semantic-required'] as const) {
      const out = parseWorkspaceConfig({ contextGraph: 'cg', node: 'n', extractionPolicy: p });
      expect(out.extractionPolicy).toBe(p);
    }
  });

  it('preserves explicit autoShare=false', () => {
    const out = parseWorkspaceConfig({ contextGraph: 'cg', node: 'n', autoShare: false });
    expect(out.autoShare).toBe(false);
  });
});

describe('workspace-config — parseAgentsMdFrontmatter', () => {
  it('extracts the `dkg:` frontmatter block and validates it', () => {
    const md = `---
title: Example
dkg:
  contextGraph: my-graph
  node: node-a
---

# Body
`;
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg).toEqual({
      contextGraph: 'my-graph',
      node: 'node-a',
      autoShare: true,
      extractionPolicy: 'structural-plus-semantic',
    });
  });

  it('throws a descriptive error when neither frontmatter nor a fenced `dkg-config` block is present', () => {
    // r21-4: the message must list BOTH supported carriers so an
    // adopter who tried (e.g.) `dkg_config` (underscore) instead of
    // `dkg-config` (hyphen) sees the canonical fence info-string in
    // the diagnostic rather than guessing.
    expect(() => parseAgentsMdFrontmatter('# No frontmatter here')).toThrow(/no workspace config found/i);
    expect(() => parseAgentsMdFrontmatter('# No frontmatter here')).toThrow(/dkg-config/);
  });

  // Bot review (PR #229 r22-5, workspace-config.ts:125): the earlier
  // "frontmatter-present ⇒ must have `dkg`" contract silently blocked
  // the documented fenced-block fallback for any AGENTS.md that uses
  // frontmatter for OTHER tooling (tags, owner, prompt metadata, …).
  // Post-r22-5 the parser falls through to the fence; we only throw
  // when NEITHER carrier produced a config. Pin BOTH halves:
  //   a) frontmatter-without-`dkg` + NO fence ⇒ descriptive error that
  //      names both expected carriers (so an adopter sees they need
  //      either the frontmatter key or the fence info-string).
  //   b) frontmatter-without-`dkg` + a valid fence ⇒ fence wins.
  it('r22-5: frontmatter lacking `dkg:` AND no fenced block → descriptive error naming both carriers', () => {
    const md = `---
title: just a title
owner: platform-team
---
body
`;
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/frontmatter is present but has no top-level `dkg:`/);
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/dkg-config/);
  });

  it('r22-5: frontmatter lacking `dkg:` FALLS THROUGH to a fenced `dkg-config` block', () => {
    // Canonical regression for the r22-5 finding: the most common
    // real-world AGENTS.md shape keeps unrelated frontmatter (tags,
    // slug, prompt version, …) AND puts the DKG config in a fence.
    // Pre-r22-5 the frontmatter short-circuit threw before the fence
    // parser ran; post-r22-5 the fence body round-trips.
    const md = [
      '---',
      'title: Project Agents',
      'tags: [workspace, dkg]',
      '---',
      '',
      '# body',
      '',
      '```dkg-config',
      'contextGraph: from-fence',
      'node: n',
      'extractionPolicy: semantic-required',
      '```',
      '',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg.contextGraph).toBe('from-fence');
    expect(cfg.node).toBe('n');
  });

  // -------------------------------------------------------------------
  // PR #229 round 21 — r21-4: plain-Markdown AGENTS.md MUST also be a
  // valid carrier for the workspace config (the canonical AGENTS.md
  // convention used by Cursor / Continue / Codex CLI is plain MD with
  // no YAML frontmatter — the spec's frontmatter-only third tier is
  // unusable for those projects). Recognise a fenced
  // ```dkg-config```  block (with optional `yaml`/`yml`/`json`
  // language hint) anywhere in the document.
  // -------------------------------------------------------------------
  it('r21-4: parses a plain-MD `dkg-config` fenced block with no frontmatter (raw fence)', () => {
    const md = [
      '# Project Agents',
      '',
      'This project uses DKG shared memory.',
      '',
      '```dkg-config',
      'contextGraph: my-graph',
      'node: http://127.0.0.1:9201',
      'autoShare: false',
      'extractionPolicy: structural-only',
      '```',
      '',
      'More prose below.',
    ].join('\n');
    const cfg = parseAgentsMdFrontmatter(md);
    expect(cfg).toEqual({
      contextGraph: 'my-graph',
      node: 'http://127.0.0.1:9201',
      autoShare: false,
      extractionPolicy: 'structural-only',
    });
  });

  it('r21-4: accepts the `yaml dkg-config` info-string variant for editor syntax-highlighting', () => {
    const md = [
      '# Body',
      '',
      '```yaml dkg-config',
      'contextGraph: g',
      'node: n',
      '```',
    ].join('\n');
    expect(parseAgentsMdFrontmatter(md).contextGraph).toBe('g');
  });

  it('r21-4: accepts the `json dkg-config` info-string variant', () => {
    const md = [
      '# Body',
      '',
      '```json dkg-config',
      '{ "contextGraph": "g", "node": "n" }',
      '```',
    ].join('\n');
    expect(parseAgentsMdFrontmatter(md).node).toBe('n');
  });

  it('r21-4: frontmatter takes priority over a fenced block when both are present', () => {
    // Defence-in-depth: if a project somehow ends up with both
    // carriers, the canonical spec-§22 frontmatter wins so a single
    // pass of the parser produces a deterministic, predictable
    // answer.
    const md = [
      '---',
      'dkg:',
      '  contextGraph: from-frontmatter',
      '  node: n',
      '---',
      '',
      '```dkg-config',
      'contextGraph: from-fence',
      'node: n',
      '```',
    ].join('\n');
    expect(parseAgentsMdFrontmatter(md).contextGraph).toBe('from-frontmatter');
  });

  it('r21-4: surfaces a descriptive error when the fenced block contains malformed YAML', () => {
    const md = [
      '# Body',
      '',
      '```dkg-config',
      'contextGraph: [unterminated',
      '```',
    ].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/dkg-config.*did not parse/i);
  });

  it('r21-4: ignores fenced blocks with a non-`dkg-config` info-string (no false positives on yaml snippets in docs)', () => {
    const md = [
      '# Body',
      '',
      'Here is an example yaml snippet, NOT a config:',
      '',
      '```yaml',
      'contextGraph: should-be-ignored',
      'node: should-be-ignored',
      '```',
    ].join('\n');
    expect(() => parseAgentsMdFrontmatter(md)).toThrow(/no workspace config found/i);
  });
});

describe('workspace-config — loadWorkspaceConfig priority order (spec §22)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-wc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when no recognised config file exists', () => {
    expect(() => loadWorkspaceConfig(dir)).toThrow(/no workspace configuration found/);
  });

  it('prefers .dkg/config.yaml over .dkg/config.json and AGENTS.md', () => {
    mkdirSync(join(dir, '.dkg'));
    writeFileSync(join(dir, '.dkg', 'config.yaml'), 'contextGraph: from-yaml\nnode: n-yaml\n');
    writeFileSync(join(dir, '.dkg', 'config.json'), JSON.stringify({ contextGraph: 'from-json', node: 'n-json' }));
    writeFileSync(join(dir, 'AGENTS.md'),
      '---\ndkg:\n  contextGraph: from-md\n  node: n-md\n---\n',
    );

    const loaded = loadWorkspaceConfig(dir);
    expect(loaded.cfg.contextGraph).toBe('from-yaml');
    expect(loaded.source.endsWith('config.yaml')).toBe(true);
  });

  it('falls back to .dkg/config.json when config.yaml is absent', () => {
    mkdirSync(join(dir, '.dkg'));
    writeFileSync(join(dir, '.dkg', 'config.json'),
      JSON.stringify({ contextGraph: 'from-json', node: 'n-json', autoShare: false }),
    );
    const loaded = loadWorkspaceConfig(dir);
    expect(loaded.cfg.contextGraph).toBe('from-json');
    expect(loaded.cfg.autoShare).toBe(false);
    expect(loaded.source.endsWith('config.json')).toBe(true);
  });

  it('falls back to AGENTS.md frontmatter when neither .dkg/config.{yaml,json} exists', () => {
    writeFileSync(join(dir, 'AGENTS.md'),
      '---\ndkg:\n  contextGraph: from-md\n  node: n-md\n  extractionPolicy: semantic-required\n---\n# body\n',
    );
    const loaded = loadWorkspaceConfig(dir);
    expect(loaded.cfg.contextGraph).toBe('from-md');
    expect(loaded.cfg.extractionPolicy).toBe('semantic-required');
    expect(loaded.source.endsWith('AGENTS.md')).toBe(true);
  });

  it('propagates parse errors from the chosen source file (invalid yaml)', () => {
    mkdirSync(join(dir, '.dkg'));
    // YAML that resolves to a non-object (a string) → parseWorkspaceConfig rejects
    writeFileSync(join(dir, '.dkg', 'config.yaml'), 'just-a-string\n');
    expect(() => loadWorkspaceConfig(dir)).toThrow(/root must be an object/);
  });

  it('r21-4: falls back to a plain-MD AGENTS.md with a fenced `dkg-config` block (no frontmatter)', () => {
    // PR #229 round 21 (r21-4): the previous frontmatter-only third
    // tier was effectively dead in workspaces whose AGENTS.md is
    // plain Markdown (the canonical AGENTS.md convention). This
    // pin walks the full priority chain end-to-end: no
    // `.dkg/config.yaml`, no `.dkg/config.json`, AGENTS.md present
    // but with NO frontmatter — only a fenced `dkg-config` block.
    // Pre-r21-4 this threw `missing YAML frontmatter`. Post-r21-4
    // it must round-trip the fence body through `parseWorkspaceConfig`.
    writeFileSync(join(dir, 'AGENTS.md'), [
      '# Project Agents',
      '',
      '```dkg-config',
      'contextGraph: plain-md-graph',
      'node: http://127.0.0.1:9201',
      'autoShare: true',
      '```',
      '',
      'Other prose.',
    ].join('\n'));
    const loaded = loadWorkspaceConfig(dir);
    expect(loaded.cfg.contextGraph).toBe('plain-md-graph');
    expect(loaded.cfg.node).toBe('http://127.0.0.1:9201');
    expect(loaded.source.endsWith('AGENTS.md')).toBe(true);
  });
});
