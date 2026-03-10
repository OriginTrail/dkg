/**
 * WriteCapture — Spike B: File-watcher-based memory write capture.
 *
 * OpenClaw's MemorySearchManager is read-only.  Memory writes happen through
 * generic file tools (write/edit) and direct filesystem writes (session-memory
 * hook).  This version of OpenClaw does not expose after_tool_call hooks to
 * plugins, so we rely entirely on filesystem watching.
 *
 * The file watcher monitors:
 *   - `MEMORY.md` at the workspace root
 *   - All `.md` files inside the `memory/` directory
 *
 * Changes are debounced (default 1.5s, matching OpenClaw's own pattern) and
 * synced to the DKG agent-memory graph via the daemon HTTP API.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { DkgDaemonClient } from './dkg-client.js';
import type { DkgOpenClawConfig, OpenClawPluginApi } from './types.js';

const AGENT_MEMORY_PARANET = 'agent-memory';

/** N-Quads namespace prefixes matching ChatMemoryManager's schema. */
const NS = {
  schema: 'http://schema.org/',
  dkg: 'http://dkg.io/ontology/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  memory: 'urn:dkg:memory:',
};

export class WriteCapture {
  private api: OpenClawPluginApi | null = null;
  private watchers: FSWatcher[] = [];
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly memoryDir: string;
  private readonly debounceMs: number;
  /** Track files we've already synced (by mtime) to avoid duplicate work. */
  private readonly syncedMtimes = new Map<string, number>();

  constructor(
    private readonly client: DkgDaemonClient,
    private readonly config: NonNullable<DkgOpenClawConfig['memory']>,
  ) {
    this.memoryDir = config.memoryDir ?? '';
    this.debounceMs = config.watchDebounceMs ?? 1500;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register(api: OpenClawPluginApi): void {
    this.api = api;

    // Note: after_tool_call hooks are not available in this version of OpenClaw.
    // All write capture relies on filesystem watching.

    // Start file watchers immediately
    this.startWatchers();

    api.logger.info?.('[dkg-write-capture] Registered — file watcher mode (no tool-call hooks available)');
  }

  // ---------------------------------------------------------------------------
  // File watchers
  // ---------------------------------------------------------------------------

  private startWatchers(): void {
    const log = this.api?.logger;

    // Watch 1: memory/ directory (recursive)
    if (this.memoryDir) {
      const absMemDir = resolve(this.memoryDir);
      if (existsSync(absMemDir)) {
        try {
          const w = watch(absMemDir, { recursive: true }, (eventType, filename) => {
            if (!filename || !filename.endsWith('.md')) return;
            this.debouncedSync(join(absMemDir, filename));
          });
          this.watchers.push(w);
          log?.info?.(`[dkg-write-capture] Watching memory dir: ${absMemDir}`);
        } catch (err: any) {
          log?.warn?.(`[dkg-write-capture] Failed to watch memory dir: ${err.message}`);
        }
      } else {
        log?.warn?.(`[dkg-write-capture] Memory dir does not exist yet: ${absMemDir}`);
      }
    }

    // Watch 2: MEMORY.md at workspace root (parent of memory/)
    const workspaceDir = this.memoryDir ? dirname(resolve(this.memoryDir)) : null;
    if (workspaceDir) {
      const memoryMd = join(workspaceDir, 'MEMORY.md');
      if (existsSync(workspaceDir)) {
        try {
          const w = watch(workspaceDir, (eventType, filename) => {
            if (filename?.toUpperCase() === 'MEMORY.MD') {
              this.debouncedSync(memoryMd);
            }
          });
          this.watchers.push(w);
          log?.info?.(`[dkg-write-capture] Watching MEMORY.md in: ${workspaceDir}`);
        } catch (err: any) {
          log?.warn?.(`[dkg-write-capture] Failed to watch workspace dir: ${err.message}`);
        }
      }
    }
  }

  /** Exposed for DkgNodePlugin to call if memoryDir wasn't available at register time. */
  startFileWatcher(memoryDir?: string): void {
    // If watchers already running, skip
    if (this.watchers.length > 0) return;
    if (memoryDir) {
      (this as any).memoryDir = memoryDir;
    }
    this.startWatchers();
  }

  private debouncedSync(fullPath: string): void {
    const existing = this.debounceTimers.get(fullPath);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(fullPath, setTimeout(async () => {
      this.debounceTimers.delete(fullPath);
      try {
        await this.syncFile(fullPath);
        this.api?.logger.info?.(`[dkg-write-capture] Synced ${basename(fullPath)} via file watcher`);
      } catch (err: any) {
        this.api?.logger.warn?.(`[dkg-write-capture] Watcher sync failed for ${basename(fullPath)}: ${err.message}`);
      }
    }, this.debounceMs));
  }

  // ---------------------------------------------------------------------------
  // Sync a memory file to DKG
  // ---------------------------------------------------------------------------

  async syncFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath);

    // Check mtime to avoid duplicate syncs
    let mtime: number;
    try {
      const stats = await stat(absPath);
      mtime = stats.mtimeMs;
    } catch {
      // File deleted — could remove from graph, but skip for now
      return;
    }

    const lastMtime = this.syncedMtimes.get(absPath);
    if (lastMtime && lastMtime >= mtime) return;

    // Read file content
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      return;
    }

    if (!content.trim()) return;

    // Build triples for the memory file
    const fileName = basename(absPath);
    let relPath = fileName;
    if (this.memoryDir) {
      const computed = relative(resolve(this.memoryDir), absPath);
      // If the file is outside memoryDir, relative() returns a path starting
      // with "..".  Fall back to just the filename to avoid odd URIs.
      relPath = computed.startsWith('..') ? fileName : computed;
    }
    const quads = buildMemoryFileQuads(relPath, content);

    if (quads.length === 0) return;

    // Write to DKG workspace
    await this.client.writeToWorkspace(AGENT_MEMORY_PARANET, quads, { localOnly: true });
    this.syncedMtimes.set(absPath, mtime);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a file path targets a memory file. */
export function isMemoryPath(filePath: unknown, memoryDir: string): boolean {
  if (typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();

  // Match MEMORY.md specifically (as a filename, not suffix)
  const segments = lower.split('/');
  const fileName = segments[segments.length - 1];
  if (fileName === 'memory.md') return true;

  // Match files inside a /memory/ directory
  if (normalized.includes('/memory/') && fileName.endsWith('.md')) return true;

  // Match against configured memory directory (with trailing separator)
  if (memoryDir) {
    const normalizedDir = memoryDir.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/';
    if (lower.startsWith(normalizedDir) || lower + '/' === normalizedDir) return true;
  }

  return false;
}

/**
 * Build RDF quads for a memory file's content.
 *
 * Each memory file becomes a `dkg:MemoryFile` entity with:
 * - `dkg:sourcePath` — the relative file path
 * - `schema:text` — the full file content
 * - `schema:dateModified` — sync timestamp
 * - `dkg:syncedAt` — when this version was synced
 *
 * Individual memory items within the file could be extracted by LLM later
 * (Layer 3 entity extraction), but for Phase 0 we store the full file.
 */
function buildMemoryFileQuads(
  relPath: string,
  content: string,
): Array<{ subject: string; predicate: string; object: string }> {
  // Sanitize the path for use as a URI component
  const uriSafe = relPath.replace(/[\\/ ]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
  const subject = `${NS.memory}file:${uriSafe}`;
  const now = new Date().toISOString();

  return [
    { subject, predicate: `${NS.rdf}type`, object: `${NS.dkg}MemoryFile` },
    { subject, predicate: `${NS.dkg}sourcePath`, object: `"${escapeLiteral(relPath)}"` },
    { subject, predicate: `${NS.schema}text`, object: `"${escapeLiteral(content)}"` },
    { subject, predicate: `${NS.schema}dateModified`, object: `"${now}"^^<${NS.xsd}dateTime>` },
    { subject, predicate: `${NS.dkg}syncedAt`, object: `"${now}"^^<${NS.xsd}dateTime>` },
  ];
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
