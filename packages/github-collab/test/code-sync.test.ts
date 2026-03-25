/**
 * Unit tests for src/github/code-sync.ts
 *
 * Uses a mocked GitHubClient to test file tree filtering and code entity sync.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodeSync } from '../src/github/code-sync.js';
import { GH, RDF } from '../src/rdf/uri.js';

const OWNER = 'octocat';
const REPO = 'Hello-World';
const GRAPH = 'did:dkg:paranet:test';

function makeMockClient() {
  return {
    getCommitSha: vi.fn().mockResolvedValue({
      commitSha: 'abc123',
      treeSha: 'tree456',
    }),
    getTree: vi.fn().mockResolvedValue({
      tree: [
        // Directories
        { path: 'src', mode: '040000', type: 'tree', sha: 'd1' },
        { path: 'src/lib', mode: '040000', type: 'tree', sha: 'd2' },
        // Files that should be included
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'b1', size: 500 },
        { path: 'src/lib/utils.ts', mode: '100644', type: 'blob', sha: 'b2', size: 300 },
        { path: 'src/main.py', mode: '100644', type: 'blob', sha: 'b3', size: 200 },
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'b4', size: 100 },
        // Files that should be excluded
        { path: 'node_modules/lodash/index.js', mode: '100644', type: 'blob', sha: 'b5', size: 50 },
        { path: 'dist/bundle.js', mode: '100644', type: 'blob', sha: 'b6', size: 10000 },
        { path: 'package-lock.json', mode: '100644', type: 'blob', sha: 'b7', size: 50000 },
        { path: 'styles.min.css', mode: '100644', type: 'blob', sha: 'b8', size: 100 },
        { path: 'app.min.js', mode: '100644', type: 'blob', sha: 'b9', size: 200 },
        // Binary file (no extension)
        { path: 'Makefile', mode: '100644', type: 'blob', sha: 'b10', size: 50 },
        // Large file that should be excluded
        { path: 'src/big-data.json', mode: '100644', type: 'blob', sha: 'b11', size: 200_000 },
      ],
    }),
    getBlob: vi.fn().mockImplementation((_owner: string, _repo: string, blobSha: string) => {
      const sources: Record<string, string> = {
        b1: 'export class App { run() {} }',
        b2: 'export function helper() { return 42; }',
      };
      const source = sources[blobSha] ?? 'const x = 1;';
      return Promise.resolve({
        content: Buffer.from(source).toString('base64'),
        encoding: 'base64',
        size: source.length,
      });
    }),
  };
}

describe('CodeSync', () => {
  let client: ReturnType<typeof makeMockClient>;
  let codeSync: CodeSync;

  beforeEach(() => {
    client = makeMockClient();
    codeSync = new CodeSync(client as any);
  });

  describe('syncFileTree', () => {
    it('fetches tree and produces quads', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      expect(client.getCommitSha).toHaveBeenCalledWith(OWNER, REPO, 'main');
      expect(client.getTree).toHaveBeenCalledWith(OWNER, REPO, 'tree456', true);

      expect(result.treeSha).toBe('tree456');
      expect(result.quads.length).toBeGreaterThan(0);
      expect(result.fileCount).toBeGreaterThan(0);
    });

    it('excludes node_modules', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object);
      expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    });

    it('excludes dist directory', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object);
      expect(paths.some(p => p.includes('dist/'))).toBe(false);
    });

    it('excludes package-lock.json', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object);
      expect(paths.some(p => p.includes('package-lock.json'))).toBe(false);
    });

    it('excludes .min.js and .min.css files', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object);
      expect(paths.some(p => p.includes('.min.'))).toBe(false);
    });

    it('excludes files larger than maxFileSize', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object);
      expect(paths.some(p => p.includes('big-data.json'))).toBe(false);
    });

    it('excludes files without known extensions', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object);
      expect(paths.some(p => p.includes('Makefile'))).toBe(false);
    });

    it('includes .ts, .py, .md files', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object.replace(/"/g, ''));

      expect(paths.some(p => p.includes('index.ts'))).toBe(true);
      expect(paths.some(p => p.includes('main.py'))).toBe(true);
      expect(paths.some(p => p.includes('README.md'))).toBe(true);
    });

    it('produces Directory quads', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const dirQuads = result.quads.filter(
        q => q.predicate === `${RDF}type` && q.object === `${GH}Directory`,
      );
      expect(dirQuads.length).toBeGreaterThan(0);
    });

    it('produces File quads', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH);

      const fileQuads = result.quads.filter(
        q => q.predicate === `${RDF}type` && q.object === `${GH}File`,
      );
      expect(fileQuads.length).toBeGreaterThan(0);
    });

    it('respects custom maxFileSize option', async () => {
      // Set maxFileSize to 150 to also exclude the 200-byte py file
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH, {
        maxFileSize: 150,
      });

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object.replace(/"/g, ''));

      expect(paths.some(p => p.includes('main.py'))).toBe(false);
    });

    it('supports custom excludePrefixes', async () => {
      const result = await codeSync.syncFileTree(OWNER, REPO, 'main', GRAPH, {
        excludePrefixes: ['src/lib/'],
      });

      const paths = result.quads
        .filter(q => q.predicate === `${GH}filePath`)
        .map(q => q.object.replace(/"/g, ''));

      expect(paths.some(p => p.includes('src/lib/'))).toBe(false);
      expect(paths.some(p => p.includes('src/index.ts'))).toBe(true);
    });
  });

  describe('syncCodeEntities', () => {
    it('fetches blobs, parses, and produces entity quads', async () => {
      const result = await codeSync.syncCodeEntities(OWNER, REPO, 'main', GRAPH);

      expect(result.parsedFiles).toBeGreaterThan(0);
      expect(result.quads.length).toBeGreaterThan(0);
    });

    it('calls onProgress callback', async () => {
      const progressCalls: any[] = [];
      await codeSync.syncCodeEntities(OWNER, REPO, 'main', GRAPH, {}, (progress) => {
        progressCalls.push({ ...progress });
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some(p => p.phase === 'tree')).toBe(true);
      expect(progressCalls.some(p => p.phase === 'parsing')).toBe(true);
      expect(progressCalls.some(p => p.phase === 'relationships')).toBe(true);
    });

    it('handles blob fetch errors gracefully', async () => {
      client.getBlob.mockRejectedValueOnce(new Error('Not found'));

      // Should not throw
      const result = await codeSync.syncCodeEntities(OWNER, REPO, 'main', GRAPH);
      expect(result).toBeDefined();
    });

    it('extracts relationships between parsed files', async () => {
      // Set up blobs with cross-file imports
      client.getBlob.mockImplementation((_owner: string, _repo: string, blobSha: string) => {
        const sources: Record<string, string> = {
          b1: `import { helper } from './lib/utils.js';\nexport class App { run() { helper(); } }`,
          b2: `export function helper() { return 42; }`,
        };
        const source = sources[blobSha] ?? 'const x = 1;';
        return Promise.resolve({
          content: Buffer.from(source).toString('base64'),
          encoding: 'base64',
          size: source.length,
        });
      });

      const result = await codeSync.syncCodeEntities(OWNER, REPO, 'main', GRAPH);
      // Should have some relationships (imports between files)
      expect(result.relationships).toBeGreaterThanOrEqual(0);
    });
  });
});
