import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildReviewMarkdown, planInstall, writeInstall, type InstallContext } from '../src/manifest/install.js';
import { type ProjectManifest, type TemplateEntity } from '../src/manifest/schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const template = (text: string, encodingFormat = 'application/json'): TemplateEntity => ({ uri: 'urn:template', text, encodingFormat });
function context(fields: Partial<ProjectManifest> & { cursorMcpJson?: TemplateEntity } = {}): InstallContext {
  const root = mkdtempSync(join(tmpdir(), 'dkg-manifest-install-'));
  roots.push(root);
  return {
    workspaceAbsPath: join(root, 'workspace'), homedir: join(root, 'home'),
    manifest: { uri: 'urn:dkg:project:team:manifest', contextGraphId: 'team', network: 'devnet', supportedTools: ['cursor', 'claude-code'], ...fields },
    agentSlug: 'local-agent', daemonApiUrl: 'http://localhost:9200', daemonTokenFile: '../auth.token',
    mcpDkgDistAbsPath: join(root, 'dist/index.js'), mcpDkgPackageDir: join(root, 'package'),
    mcpDkgSrcAbsPath: join(root, 'src/index.ts'), captureScriptPath: join(root, 'capture.mjs'),
    injectSessionContextScriptPath: join(root, 'inject.mjs'),
  };
}
function write(file: string, body: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); }

describe('manifest install planning', () => {
  it('plans exact allowlisted targets without creating files and measures substituted UTF-8 bytes', () => {
    const ctx = context({ cursorRule: template('Ž {{agentUri}} {{agentNickname}} {{agentAddress}} {{network}}', 'text/plain'),
      cursorHooksTemplate: template('{}'), claudeHooksTemplate: template('{}'), configTemplate: template('project: {{contextGraphId}}'),
      agentsMd: template('# {{agentSlug}}'), cursorMcpJson: template('{}') });
    Object.assign(ctx, { agentUri: 'urn:wallet:123', agentNickname: 'Ana laptop', agentAddress: '0x123' });
    const plan = planInstall(ctx);
    expect(plan.files.map(f => [f.field, f.absPath, f.exists, f.merges])).toEqual([
      ['cursorRule', join(ctx.workspaceAbsPath, '.cursor/rules/dkg-annotate.mdc'), false, false],
      ['cursorHooksTemplate', join(ctx.workspaceAbsPath, '.cursor/hooks.json'), false, false],
      ['claudeHooksTemplate', join(ctx.homedir!, '.claude/settings.json'), false, true],
      ['configTemplate', join(ctx.workspaceAbsPath, '.dkg/config.yaml'), false, false],
      ['agentsMd', join(ctx.workspaceAbsPath, 'AGENTS.md'), false, false],
      ['cursorMcpJson', join(ctx.workspaceAbsPath, '.cursor/mcp.json'), false, true],
    ]);
    expect(plan.files[0].body).toBe('Ž urn:wallet:123 Ana laptop 0x123 devnet');
    expect(plan.files[0].bytes).toBe(Buffer.byteLength('Ž urn:wallet:123 Ana laptop 0x123 devnet'));
    expect(plan.warnings).toEqual([]);
    expect(readdirSync(roots[0])).toEqual([]);
  });

  it.each([
    ['cursor', ['cursorRule', 'cursorHooksTemplate', 'configTemplate', 'agentsMd', 'cursorMcpJson']],
    ['claude-code', ['claudeHooksTemplate', 'configTemplate', 'agentsMd']],
  ] as const)('honors %s-only selection even when the manifest carries other tool templates', (tool, expected) => {
    const ctx = context({ supportedTools: [tool], cursorRule: template('rule'), cursorHooksTemplate: template('{}'),
      claudeHooksTemplate: template('{}'), configTemplate: template('config'), agentsMd: template('agents'), cursorMcpJson: template('{}') });
    const plan = planInstall(ctx);
    expect(plan.files.map(f => f.field)).toEqual(expected);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain(`supportedTools doesn't include ${tool === 'cursor' ? 'claude-code' : 'cursor'}`);
  });

  it('retains legacy identity substitutions and explains an empty install', () => {
    const ctx = context();
    const plan = planInstall(ctx);
    expect(plan.files).toEqual([]);
    expect(plan.substitutionValues).toMatchObject({ agentUri: 'urn:dkg:agent:local-agent', agentNickname: 'local-agent', agentAddress: '' });
    expect(buildReviewMarkdown(ctx.manifest, plan)).toContain('No files would be written');
  });
});

describe('manifest writes on real temporary files', () => {
  it('creates and overwrites text, reports byte counts, and previews both actions', async () => {
    const ctx = context({ agentsMd: template('Ž team instructions', 'text/markdown'), publishedBy: 'urn:curator',
      publishedAt: '2026-01-01T00:00:00Z', requiresMcpDkgVersion: '^10', ontologyUri: 'urn:ontology' });
    const initial = planInstall(ctx);
    expect(buildReviewMarkdown(ctx.manifest, initial)).toContain('**create**');
    expect(await writeInstall(initial)).toEqual([{ field: 'agentsMd', absPath: initial.files[0].absPath,
      bytesWritten: Buffer.byteLength('Ž team instructions'), action: 'created' }]);
    ctx.manifest.agentsMd!.text = 'updated';
    const next = planInstall(ctx);
    const review = buildReviewMarkdown(ctx.manifest, next);
    for (const detail of ['**overwrite**', 'urn:curator', '2026-01-01T00:00:00Z', '^10', 'urn:ontology', next.files[0].absPath]) expect(review).toContain(detail);
    expect((await writeInstall(next))[0].action).toBe('overwrote');
    expect(readFileSync(next.files[0].absPath, 'utf8')).toBe('updated');
  });

  it('merges files created after preview, preserves unrelated keys and deduplicates hooks on repeated installs', async () => {
    const hook = { matcher: 'startup', hooks: [{ type: 'command', command: 'local-dkg-hook' }] };
    const own = { matcher: 'other', hooks: [{ type: 'command', command: 'existing-hook' }] };
    const addition = { _comment: 'generator metadata', hooks: { _comment: 'nested metadata', SessionStart: [hook, hook] }, enabled: true };
    const ctx = context({ claudeHooksTemplate: template(JSON.stringify(addition)) });
    const plan = planInstall(ctx);
    expect(plan.files[0].exists).toBe(false);
    write(plan.files[0].absPath, JSON.stringify({ theme: 'dark', hooks: { SessionStart: [own], Stop: ['keep'] }, enabled: false }));
    const expected = { theme: 'dark', hooks: { SessionStart: [own, hook], Stop: ['keep'] }, enabled: true };
    for (let round = 0; round < 2; round++) {
      expect((await writeInstall(plan))[0].action).toBe('merged');
      expect(JSON.parse(readFileSync(plan.files[0].absPath, 'utf8'))).toEqual(expected);
    }
    const review = buildReviewMarkdown(ctx.manifest, planInstall(ctx));
    expect(review).toContain('**merge** (preserves your other keys)');
  });

  it.each(['{broken', ''])('merges or refuses existing JSON without losing its content (%j)', async existing => {
    const ctx = context({ cursorMcpJson: template('{"mcpServers":{"dkg":{"command":"node"}}}') });
    const plan = planInstall(ctx);
    write(plan.files[0].absPath, existing);
    if (existing) {
      await expect(writeInstall(plan)).rejects.toThrow('existing file is not valid JSON; refusing to overwrite');
      expect(readFileSync(plan.files[0].absPath, 'utf8')).toBe(existing);
    } else {
      expect((await writeInstall(plan))[0].action).toBe('merged');
      expect(JSON.parse(readFileSync(plan.files[0].absPath, 'utf8'))).toEqual({ mcpServers: { dkg: { command: 'node' } } });
    }
  });

  it('refuses malformed additions and preserves the existing configuration', async () => {
    const ctx = context({ cursorMcpJson: template('{broken') });
    const plan = planInstall(ctx);
    const before = '{"mcpServers":{"other":{"command":"keep"}}}';
    write(plan.files[0].absPath, before);
    await expect(writeInstall(plan)).rejects.toThrow('Failed to merge');
    expect(readFileSync(plan.files[0].absPath, 'utf8')).toBe(before);
  });

  it('surfaces tool-selection warnings in the review before writing', () => {
    const ctx = context({ supportedTools: ['cursor'], claudeHooksTemplate: template('{}') });
    const plan = planInstall(ctx);
    expect(buildReviewMarkdown(ctx.manifest, plan)).toContain(plan.warnings[0]);
    expect(readdirSync(roots[0])).toEqual([]);
  });
});
