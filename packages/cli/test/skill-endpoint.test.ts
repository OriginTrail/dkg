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
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens)) return;
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
    expect(skillContent).toContain('Verified Memory (VM)');
  });

  it('includes key available API endpoints', () => {
    expect(skillContent).toContain('/api/shared-memory/write');
    expect(skillContent).toContain('/api/shared-memory/publish');
    expect(skillContent).toContain('/api/query');
    expect(skillContent).toContain('/api/context-graph/create');
    expect(skillContent).toContain('/api/context-graph/list');
    expect(skillContent).toContain('/api/status');
  });

  it('marks planned endpoints clearly', () => {
    // The Planned/🚧 markers in the skill doc cover context graph sub-resources
    // and future agent profile endpoints — NOT the assertion API, which ships
    // as of PR #108 (create/write/query/promote/discard) and this PR (import-file,
    // extraction-status).
    expect(skillContent).toContain('*(planned)*');
  });

  it('documents the now-shipped assertion API surface', () => {
    expect(skillContent).toContain('/api/assertion/create');
    expect(skillContent).toContain('/api/assertion/{name}/write');
    expect(skillContent).toContain('/api/assertion/{name}/query');
    expect(skillContent).toContain('/api/assertion/{name}/promote');
    expect(skillContent).toContain('/api/assertion/{name}/discard');
    expect(skillContent).toContain('/api/assertion/{name}/import-file');
    expect(skillContent).toContain('/api/assertion/{name}/extraction-status');
  });

  it('documents error status codes', () => {
    expect(skillContent).toContain('| 400 |');
    expect(skillContent).toContain('| 401 |');
    expect(skillContent).toContain('| 403 |');
    expect(skillContent).toContain('| 404 |');
    expect(skillContent).toContain('| 409 |');
  });

  it('includes V9 to V10 migration table', () => {
    expect(skillContent).toContain('V9 → V10 Migration');
    expect(skillContent).toContain('Paranet');
    expect(skillContent).toContain('Context Graph');
  });

  it('is under 500 lines (Agent Skills best practice)', () => {
    const lines = skillContent.split('\n').length;
    expect(lines).toBeLessThan(500);
  });
});
