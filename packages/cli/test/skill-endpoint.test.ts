import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { httpAuthGuard } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Auth: /.well-known/skill.md is a public path
// ---------------------------------------------------------------------------

describe('httpAuthGuard — /.well-known/skill.md', () => {
  const VALID_TOKEN = 'secret';
  const validTokens = new Set([VALID_TOKEN]);
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await httpAuthGuard(req, res, true, validTokens))) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('allows /.well-known/skill.md without a token (public endpoint)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/skill.md`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('ok');
  });

  it('still rejects other protected endpoints without token', async () => {
    const res = await fetch(`${baseUrl}/api/publish`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// SKILL.md file content
// ---------------------------------------------------------------------------

describe('SKILL.md file', () => {
  let skillContent: string;

  beforeEach(() => {
    const skillPath = new URL('../skills/dkg-node/SKILL.md', import.meta.url);
    skillContent = readFileSync(skillPath, 'utf-8');
  });

  it('starts with Agent Skills YAML frontmatter', () => {
    expect(skillContent).toMatch(/^---\r?\n/);
    expect(skillContent).toContain('name: dkg-node');
    expect(skillContent).toContain('description:');
    expect(skillContent).toMatch(/---\r?\n\r?\n/);
  });

  it('contains the required DKG V10 sections', () => {
    expect(skillContent).toContain('## 1. Node Info');
    expect(skillContent).toContain('## 2. Capabilities Overview');
    expect(skillContent).toContain('## 3. Quick Start');
    expect(skillContent).toContain('## 4. Authentication');
    expect(skillContent).toContain('## 5. Memory Model');
    expect(skillContent).toContain('## 6. Context Graphs');
    expect(skillContent).toContain('## 7. File Ingestion');
    expect(skillContent).toContain('## 8. Node Administration');
    expect(skillContent).toContain('## 9. Error Reference');
    expect(skillContent).toContain('## 10. Common Workflows');
  });

  it('contains dynamic placeholders for node info', () => {
    expect(skillContent).toContain('(dynamic)');
    expect(skillContent).toContain('**Node version:**');
    expect(skillContent).toContain('**Base URL:**');
    expect(skillContent).toContain('**Peer ID:**');
  });

  it('documents the three memory layers', () => {
    expect(skillContent).toContain('Working Memory (WM)');
    expect(skillContent).toContain('Shared Working Memory (SWM)');
    expect(skillContent).toContain('Verifiable Memory (VM)');
  });

  it('includes key available API endpoints', () => {
    expect(skillContent).toContain('/api/knowledge-assets/{name}/swm/share');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/vm/publish');
    expect(skillContent).toContain('/api/query');
    expect(skillContent).toContain('/api/context-graph/create');
    expect(skillContent).toContain('/api/context-graph/list');
    expect(skillContent).toContain('/api/status');
  });

  it('does not advertise the removed SWM-bridge publish route', () => {
    // The legacy /api/shared-memory/publish bridge was deleted (issues #1087/#1116);
    // the canonical SWM→VM publish is the per-KA /vm/publish route.
    expect(skillContent).not.toContain('/api/shared-memory/publish');
  });

  it('marks planned endpoints clearly', () => {
    // The Planned/🚧 markers in the skill doc cover context graph sub-resources
    // and future agent profile endpoints — NOT the assertion API, which ships
    // as of PR #108 (create/write/query/promote/discard) and this PR (import-file,
    // extraction-status).
    expect(skillContent).toContain('*(planned)*');
  });

  it('documents the now-shipped knowledge-asset API surface', () => {
    expect(skillContent).toContain('/api/knowledge-assets');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/write');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/quads');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/swm/share');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/discard');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/import-file');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/extraction-status');
  });

  it('documents the rc.17 lifecycle verbs (finalize / publish / pull-from) + the UAL', () => {
    // CONTRACT §1: the 5-stage lifecycle (create → write → finalize → share →
    // publish) and the pull-from edit-loop primitive must all be taught, and the
    // UAL returned at publish must be defined.
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/finalize');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/vm/publish');
    expect(skillContent).toContain('/api/knowledge-assets/{name}/wm/pull-from');
    // The new tool names are advertised in the tool-reference table.
    expect(skillContent).toContain('dkg_knowledge_asset_finalize');
    expect(skillContent).toContain('dkg_knowledge_asset_publish');
    expect(skillContent).toContain('dkg_knowledge_asset_pull_from');
    expect(skillContent).toContain('dkg_knowledge_asset_share');
    // UAL is defined and tied to the publish response (CONTRACT §1 Stage5).
    expect(skillContent).toContain('UAL');
    expect(skillContent).toContain('Universal Asset Locator');
    // The UAL middle segment is the KnowledgeAssets (KAV10) CONTRACT address, NOT
    // the author (getDKGKnowledgeAssetsAddress; update-handler.ts:208/361).
    expect(skillContent).toContain('did:dkg:<chainId>/<kasAddress>/<number>');
    expect(skillContent).not.toContain('did:dkg:<chainId>/<author>/<number>');
    expect(skillContent).not.toContain('did:dkg:<chainId>/<authorAddress>/<number>');
    // The canonical 5-stage sequence is spelled out.
    expect(skillContent).toContain('create → write → finalize → share → publish');
  });

  it('documents imported attachment semantic enrichment as same-assertion append', () => {
    // rc.17 rename (CONTRACT §2): the import-artifact / semantic-enrichment tools
    // are part of the dkg_knowledge_asset_* family now — no dkg_assertion_* /
    // dkg_import_artifact_* / dkg_semantic_enrichment_* back-compat names remain.
    expect(skillContent).toContain('dkg_knowledge_asset_import_artifact_read_markdown');
    expect(skillContent).toContain('dkg_knowledge_asset_import_artifact_resolve');
    expect(skillContent).toContain('dkg_knowledge_asset_semantic_enrichment_write');
    expect(skillContent).toContain('appends model-derived semantic triples');
    expect(skillContent).toContain('same imported assertion graph');
    expect(skillContent).toContain('Optional metadata re-check');
    expect(skillContent).toContain('rejects target assertion names');
    expect(skillContent).not.toContain('separate Working Memory assertion');
    // The legacy short names must be fully gone from the canonical skill doc.
    expect(skillContent).not.toContain('dkg_import_artifact_read_markdown');
    expect(skillContent).not.toContain('dkg_import_artifact_resolve');
    expect(skillContent).not.toContain('dkg_semantic_enrichment_write');
  });

  it('documents error status codes', () => {
    expect(skillContent).toContain('| 400 |');
    expect(skillContent).toContain('| 401 |');
    expect(skillContent).toContain('| 403 |');
    expect(skillContent).toContain('| 404 |');
    expect(skillContent).toContain('| 409 |');
  });

  it('does NOT contain V9 to V10 migration table (removed — first product release)', () => {
    expect(skillContent).not.toContain('V9 → V10 Migration');
    expect(skillContent).not.toContain('| ContextGraph | Context Graph |');
    expect(skillContent).not.toContain('| `POST /api/workspace/write`');
  });

  it('stays within a reasonable size budget (Agent Skills best practice)', () => {
    // the previous hard cap of 500 lines was set
    // when the skill doc only covered Phase-3 endpoints (publish /
    // query / status). It has since grown to document the assertion
    // API surface (PR #108: create/write/query/promote/discard, plus
    // import-file + extraction-status), the V10 context graph
    // registry, the workspace-config (AGENTS.md / .dkg/config.yaml)
    // pickup paths, and the auth troubleshooting + adapter tool
    // reference (PRs #247, #251) — all of which are explicitly
    // pinned by other tests in this suite. Keeping the original
    // 500-line cap would force regressions of legitimate
    // documentation that other tests REQUIRE.
    //
    // rc.17 agent-tooling (PR1) raised the cap 800 → 900: the doc now teaches the
    // full GitHub-shaped KA lifecycle — the two new on-chain verbs
    // (`wm/finalize` seal + `vm/publish` mint), the `wm/pull-from` edit-loop
    // primitive, the publish response body + UAL definition, and the canonical
    // 5-stage workflow (create → write → finalize → share → publish). That is
    // ~90 lines of content the OTHER tests in this suite (and skill-route-parity)
    // explicitly REQUIRE, so a lower cap would force regressing required docs.
    //
    // The cap was raised 800 → 900 → 950 across rc.17 agent-tooling as the doc grew
    // with the lifecycle teaching + the review-round accuracy corrections (UAL format,
    // register/publishPolicy caveat, create-failure recovery semantics) — content we
    // deliberately added, where trimming would regress the accuracy we just fixed.
    //
    // Resident-author selection (GH#1786) raised the cap 950 → 1000. The added
    // contract distinguishes selection from authorship and documents the
    // synchronous/async non-custodial failure modes; omitting it would make the
    // canonical skill inaccurate for the newly exposed API.
    //
    // 1000 lines stays a realistic ceiling: well below the documented Agent Skills
    // "should be concise" guidance for very large skills, while still catching
    // unbounded growth (e.g. an accidental dump of full OpenAPI schema in-line).
    const lines = skillContent.split('\n').length;
    expect(lines).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Auth: /.well-known/skill-importer.md is a public path
// (PR #4 + Codex PR #642 follow-up — the bulk-import skill was previously
//  unreachable for setup-flow-installed agents because only dkg-node/SKILL.md
//  was served. This test pins the public-path allowlist for the new endpoint.)
// ---------------------------------------------------------------------------

describe('httpAuthGuard — /.well-known/skill-importer.md', () => {
  const VALID_TOKEN = 'secret';
  const validTokens = new Set([VALID_TOKEN]);
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await httpAuthGuard(req, res, true, validTokens))) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('allows /.well-known/skill-importer.md without a token (public endpoint)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/skill-importer.md`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('ok');
  });

  it('allows HEAD /.well-known/skill-importer.md without a token', async () => {
    const res = await fetch(`${baseUrl}/.well-known/skill-importer.md`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// dkg-importer/SKILL.md file content
// ---------------------------------------------------------------------------

describe('dkg-importer/SKILL.md file', () => {
  let importerContent: string;

  beforeEach(() => {
    const skillPath = new URL('../skills/dkg-importer/SKILL.md', import.meta.url);
    importerContent = readFileSync(skillPath, 'utf-8');
  });

  it('starts with Agent Skills YAML frontmatter', () => {
    expect(importerContent).toMatch(/^---\r?\n/);
    expect(importerContent).toContain('name: dkg-importer');
    expect(importerContent).toContain('description:');
    expect(importerContent).toMatch(/---\r?\n\r?\n/);
  });

  it('documents the chunking contract from ADR 0002', () => {
    expect(importerContent).toContain('CHUNK');
    expect(importerContent).toContain('ROOT_CHUNK');
  });

  it('documents the manifest pattern', () => {
    expect(importerContent).toContain('createImportManifest');
    expect(importerContent).toContain('markPartitionStatus');
    expect(importerContent).toContain('loadImportManifest');
  });

  it('documents the three known daemon caps with verbatim error strings', () => {
    expect(importerContent).toContain('MAX_BODY_BYTES');
    expect(importerContent).toContain('SMALL_BODY_BYTES');
    expect(importerContent).toContain('Promoted assertion too large for gossip');
  });
});
