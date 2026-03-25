/**
 * Code Sync — fetches and indexes repository file trees and code entities from GitHub.
 *
 * Phase A: Uses the recursive git tree API to index all files and directories.
 * Phase B: Fetches file contents, parses code entities via parser registry.
 * Phase C: Extracts cross-file relationships (imports, inheritance).
 */

import { GitHubClient } from './client.js';
import { transformFileTree, transformCodeEntities, transformRelationships, type GitTreeEntry } from '../rdf/code-transformer.js';
import type { Quad } from '../rdf/uri.js';
import type { ParseResult } from '../code/parser.js';
import { getParser, isParseable } from '../code/parser-registry.js';
import { buildFileIndex, extractRelationships } from '../code/relationship-extractor.js';

/** Default file extensions to include. */
const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sol',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.json',
  '.yaml', '.yml',
  '.toml',
  '.md',
  '.css', '.scss',
  '.html',
  '.sh', '.bash',
  '.sql',
  '.graphql', '.gql',
  '.rb', '.php', '.swift', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.proto',
]);

/** Default path prefixes to exclude. */
const DEFAULT_EXCLUDE_PREFIXES = [
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  'coverage/',
  '__pycache__/',
  'target/',
  'vendor/',
  'third_party/',
  '.next/',
  '.nuxt/',
];

/** Default filename suffixes to exclude. */
const DEFAULT_EXCLUDE_SUFFIXES = [
  '.min.js', '.min.css', '.map',
  '.lock',
];

/** Default exact filenames to exclude. */
const DEFAULT_EXCLUDE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export interface CodeSyncOptions {
  /** Maximum file size in bytes to include (default: 100KB). */
  maxFileSize?: number;
  /** Additional path prefixes to exclude. */
  excludePrefixes?: string[];
  /** Additional extensions to include. */
  includeExtensions?: string[];
}

export interface CodeSyncResult {
  quads: Quad[];
  treeSha: string;
  fileCount: number;
  directoryCount: number;
}

export interface CodeEntitySyncResult {
  quads: Quad[];
  parsedFiles: number;
  totalEntities: number;
  totalImports: number;
  relationships: number;
}

export interface CodeSyncProgress {
  phase: 'tree' | 'parsing' | 'relationships';
  current: number;
  total: number;
}

export class CodeSync {
  private readonly client: GitHubClient;

  constructor(client: GitHubClient) {
    this.client = client;
  }

  async syncFileTree(
    owner: string,
    repo: string,
    branch: string,
    graph: string,
    options: CodeSyncOptions = {},
  ): Promise<CodeSyncResult> {
    const maxSize = options.maxFileSize ?? 100_000;

    // 1. Get the tree SHA from the branch HEAD
    const { treeSha } = await this.client.getCommitSha(owner, repo, branch);

    // 2. Get the full recursive tree
    const treeData = await this.client.getTree(owner, repo, treeSha, true);
    const allEntries: GitTreeEntry[] = treeData.tree ?? [];

    // 3. Filter entries
    const filtered = this.filterEntries(allEntries, maxSize, options);

    // 4. Transform to quads
    const quads = transformFileTree(filtered, owner, repo, graph);

    const fileCount = filtered.filter(e => e.type === 'blob').length;
    const directoryCount = filtered.filter(e => e.type === 'tree').length;

    return { quads, treeSha, fileCount, directoryCount };
  }

  /**
   * Phase B+C: Fetch file contents, parse code entities, and extract relationships.
   *
   * Fetches blobs in batches with concurrency control, parses via the language
   * parser registry, and resolves cross-file relationships.
   */
  async syncCodeEntities(
    owner: string,
    repo: string,
    branch: string,
    graph: string,
    options: CodeSyncOptions = {},
    onProgress?: (progress: CodeSyncProgress) => void,
    existingTreeSha?: string,
  ): Promise<CodeEntitySyncResult> {
    const maxSize = options.maxFileSize ?? 100_000;

    // 1. Get tree (reuse treeSha if already fetched by syncFileTree)
    onProgress?.({ phase: 'tree', current: 0, total: 1 });
    const treeSha = existingTreeSha ?? (await this.client.getCommitSha(owner, repo, branch)).treeSha;
    const treeData = await this.client.getTree(owner, repo, treeSha, true);
    const allEntries: GitTreeEntry[] = treeData.tree ?? [];
    const filtered = this.filterEntries(allEntries, maxSize, options);
    onProgress?.({ phase: 'tree', current: 1, total: 1 });

    // 2. Filter to parseable files only
    const parseableFiles = filtered.filter(e => e.type === 'blob' && isParseable(e.path));

    // 3. Fetch and parse blobs in batches
    let batchSize = 20;
    let batchDelayMs = 50;
    const parsedFiles = new Map<string, ParseResult>();
    const quads: Quad[] = [];
    let totalEntities = 0;
    let totalImports = 0;

    for (let i = 0; i < parseableFiles.length; i += batchSize) {
      // Check rate limit before each batch and throttle if running low
      const rateLimit = this.client.getRateLimit();
      if (rateLimit && rateLimit.remaining < 100) {
        console.warn(`[CodeSync] Rate limit low (${rateLimit.remaining} remaining), reducing batch size`);
        batchSize = 5;
        batchDelayMs = 500;
      }

      const batch = parseableFiles.slice(i, i + batchSize);
      onProgress?.({ phase: 'parsing', current: i, total: parseableFiles.length });

      const results = await Promise.all(
        batch.map(async (entry) => {
          try {
            const blob = await this.client.getBlob(owner, repo, entry.sha);
            const source = Buffer.from(blob.content, 'base64').toString('utf-8');
            const parser = getParser(entry.path);
            if (!parser) return null;
            const result = await parser.parse(source, entry.path);
            return { path: entry.path, result };
          } catch {
            return null;
          }
        }),
      );

      for (const r of results) {
        if (!r) continue;
        parsedFiles.set(r.path, r.result);
        const entityQuads = transformCodeEntities(r.result, r.path, owner, repo, graph);
        quads.push(...entityQuads);
        totalEntities += r.result.entities.length;
        totalImports += r.result.imports.length;
      }

      // Delay between batches to be respectful of rate limits
      if (i + batchSize < parseableFiles.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelayMs));
      }
    }

    onProgress?.({ phase: 'parsing', current: parseableFiles.length, total: parseableFiles.length });

    // 4. Phase C: Extract relationships
    onProgress?.({ phase: 'relationships', current: 0, total: 1 });
    const fileIndex = buildFileIndex(parsedFiles);
    const relationships = extractRelationships(fileIndex, owner, repo);
    const relQuads = transformRelationships(relationships, graph);
    quads.push(...relQuads);
    onProgress?.({ phase: 'relationships', current: 1, total: 1 });

    return {
      quads,
      parsedFiles: parsedFiles.size,
      totalEntities,
      totalImports,
      relationships: relationships.length,
    };
  }

  private filterEntries(
    entries: GitTreeEntry[],
    maxSize: number,
    options: CodeSyncOptions,
  ): GitTreeEntry[] {
    const includeExt = new Set(DEFAULT_INCLUDE_EXTENSIONS);
    if (options.includeExtensions) {
      for (const ext of options.includeExtensions) {
        includeExt.add(ext.startsWith('.') ? ext : `.${ext}`);
      }
    }

    const excludePrefixes = [
      ...DEFAULT_EXCLUDE_PREFIXES,
      ...(options.excludePrefixes ?? []),
    ];

    return entries.filter(entry => {
      // Always keep directory entries (tree type)
      if (entry.type === 'tree') {
        // Exclude directories that match exclude prefixes
        return !excludePrefixes.some(p => entry.path.startsWith(p) || entry.path.includes(`/${p}`));
      }

      // For files (blobs):

      // Check exclude prefixes
      if (excludePrefixes.some(p => entry.path.startsWith(p) || entry.path.includes(`/${p}`))) {
        return false;
      }

      // Check excluded filenames
      const fileName = entry.path.split('/').pop() ?? entry.path;
      if (DEFAULT_EXCLUDE_NAMES.has(fileName)) {
        return false;
      }

      // Check excluded suffixes
      if (DEFAULT_EXCLUDE_SUFFIXES.some(s => entry.path.endsWith(s))) {
        return false;
      }

      // Check file size
      if (typeof entry.size === 'number' && entry.size > maxSize) {
        return false;
      }

      // Check extension
      const dotIdx = fileName.lastIndexOf('.');
      if (dotIdx < 0) return false;
      const ext = fileName.substring(dotIdx).toLowerCase();
      return includeExt.has(ext);
    });
  }
}
