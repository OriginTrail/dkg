import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkgClient } from '../src/client.js';
import {
  assembleStandardTemplates,
  composeManifestQuads,
  publishManifest,
} from '../src/manifest/publish.js';
import { ManifestP, NS, WORKSPACE_TARGETS } from '../src/manifest/schema.js';
import { makeConfig } from './harness.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-manifest-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
const input = {
  contextGraphId: 'team',
  network: 'testnet' as const,
  supportedTools: ['cursor', 'claude-code'] as Array<'cursor' | 'claude-code'>,
  publisherAgentUri: 'urn:curator',
  templates: {},
};
function writeCanonicalFiles() {
  fs.mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.cursor/rules/dkg-annotate.mdc'),
    '# Cursor\nPreserve "quoted" paths: C:\\work\r\n\tŽiva',
  );
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Team rules\nDo not lose this newline.\n');
}

describe('canonical manifest assembly', () => {
  it('reports which canonical input is missing instead of publishing an incomplete template set', () => {
    expect(() => assembleStandardTemplates(root)).toThrow(
      `Canonical cursor rule not found at ${path.join(root, '.cursor/rules/dkg-annotate.mdc')}`,
    );
    fs.mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor/rules/dkg-annotate.mdc'), '# Cursor');
    expect(() => assembleStandardTemplates(root)).toThrow(
      `Canonical AGENTS.md not found at ${path.join(root, 'AGENTS.md')}`,
    );
  });
  it('preserves canonical file bytes and emits linked, typed templates with escaped RDF literals', () => {
    writeCanonicalFiles();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    const templates = assembleStandardTemplates(root);
    expect(Object.keys(templates).sort()).toEqual([
      'agentsMd',
      'claudeHooksTemplate',
      'configTemplate',
      'cursorHooksTemplate',
      'cursorMcpJson',
      'cursorRule',
    ]);
    expect(templates.agentsMd?.text).toBe(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'));
    expect(templates.cursorRule?.text).toBe(
      fs.readFileSync(path.join(root, '.cursor/rules/dkg-annotate.mdc'), 'utf8'),
    );
    const manifest = composeManifestQuads({
      ...input,
      templates,
      ontologyUri: 'urn:ontology',
      requiresMcpDkgVersion: '>=1.0.0',
    });
    expect(manifest.quads).toContainEqual({
      subject: manifest.manifestUri,
      predicate: ManifestP.ontology,
      object: '<urn:ontology>',
    });
    expect(manifest.quads).toContainEqual({
      subject: manifest.manifestUri,
      predicate: ManifestP.requiresMcpDkgVersion,
      object: '">=1.0.0"',
    });
    expect(manifest.quads).toContainEqual({
      subject: manifest.manifestUri,
      predicate: NS.dcterms + 'created',
      object: '"2026-01-02T03:04:05.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    });
    expect(manifest.quads).toContainEqual({
      subject: manifest.templateUris.cursorRule,
      predicate: NS.schema + 'text',
      object: '"# Cursor\\nPreserve \\"quoted\\" paths: C:\\\\work\\r\\n\\tŽiva"',
    });
    for (const [key, uri] of Object.entries(manifest.templateUris)) {
      expect(manifest.quads).toContainEqual({
        subject: uri,
        predicate: NS.schema + 'about',
        object: `<${manifest.manifestUri}>`,
      });
      expect(manifest.quads).toContainEqual({
        subject: uri,
        predicate: NS.dkgOnboard + 'workspaceTarget',
        object: `"${(WORKSPACE_TARGETS as Record<string, string>)[key] ?? '<workspace>/.cursor/mcp.json'}"`,
      });
    }
  });
});

describe('manifest publication sequencing', () => {
  it('clears an old draft, tolerates first-publish cleanup 404, then writes without sharing when opted out', async () => {
    const calls: Array<{ route: string; body: unknown }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: async (url, init) => {
        const route = new URL(String(url)).pathname;
        calls.push({ route, body: JSON.parse(String(init?.body)) });
        return route.endsWith('/discard')
          ? Response.json({ error: 'not found' }, { status: 404 })
          : Response.json({});
      },
    });
    const result = await publishManifest({
      ...input,
      client,
      assertionName: 'onboarding',
      autoShare: false,
    });
    expect(calls.map((call) => call.route)).toEqual([
      '/api/sub-graph/create',
      '/api/knowledge-assets/onboarding/wm/discard',
      '/api/knowledge-assets/onboarding/wm/write',
    ]);
    expect(calls[1].body).toMatchObject({ contextGraphId: 'team', subGraphName: 'meta' });
    expect(calls[2].body).toMatchObject({
      contextGraphId: 'team',
      subGraphName: 'meta',
      quads: expect.any(Array),
    });
    expect(result.tripleCount).toBe((calls[2].body as { quads: unknown[] }).quads.length);
    expect(result.templateUris).toEqual({});
  });
  it.each([
    { swmShared: true, sealed: false, publishReady: true },
    { swmShared: true, sealed: true, publishReady: false },
  ])('rejects incomplete atomic share: %j', async (share) => {
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: async (url) => Response.json(String(url).endsWith('/swm/share') ? share : {}),
    });
    await expect(publishManifest({ ...input, client })).rejects.toThrow(
      'Manifest atomic share did not reach SWM',
    );
  });
  it('does not attempt sharing after the manifest write fails', async () => {
    const routes: string[] = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: async (url) => {
        const route = new URL(String(url)).pathname;
        routes.push(route);
        return route.endsWith('/wm/write')
          ? Response.json({ error: 'write rejected' }, { status: 422 })
          : Response.json({});
      },
    });
    await expect(publishManifest({ ...input, client })).rejects.toThrow('write rejected');
    expect(routes.some((route) => route.endsWith('/swm/share'))).toBe(false);
  });
});
