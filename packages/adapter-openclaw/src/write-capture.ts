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
import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DkgDaemonClient } from './dkg-client.js';
import type { DkgOpenClawConfig, OpenClawPluginApi } from './types.js';

export class WriteCapture {
  private api: OpenClawPluginApi | null = null;
  private watchers: FSWatcher[] = [];
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly memoryDir: string;
  private readonly debounceMs: number;
  /** Track files we've already synced (by mtime) to avoid duplicate work. */
  private readonly syncedMtimes = new Map<string, number>();
  /** Track previous file content for delta computation. */
  private readonly syncedContents = new Map<string, string>();

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

  private async startWatchers(): Promise<void> {
    const log = this.api?.logger;

    // Seed syncedContents with current file state so we don't reimport
    // everything on every gateway restart. Only new changes get imported.
    await this.seedExistingContent();

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

  /**
   * Seed syncedContents with current file state on startup.
   * This prevents reimporting the full file on every gateway restart.
   * Only changes made *after* startup will be imported as deltas.
   */
  private async seedExistingContent(): Promise<void> {
    const log = this.api?.logger;
    const filesToSeed: string[] = [];

    // Collect MEMORY.md
    const workspaceDir = this.memoryDir ? dirname(resolve(this.memoryDir)) : null;
    if (workspaceDir) {
      const memoryMd = join(workspaceDir, 'MEMORY.md');
      if (existsSync(memoryMd)) filesToSeed.push(memoryMd);
    }

    // Collect memory/*.md files
    if (this.memoryDir) {
      const absMemDir = resolve(this.memoryDir);
      if (existsSync(absMemDir)) {
        try {
          const entries = readdirSync(absMemDir, { recursive: true });
          for (const entry of entries) {
            const name = String(entry);
            if (name.endsWith('.md')) {
              filesToSeed.push(join(absMemDir, name));
            }
          }
        } catch (err: any) {
          log?.warn?.(`[dkg-write-capture] Failed to scan memory dir for seeding: ${err.message}`);
        }
      }
    }

    // Read each file and store its content + mtime without importing
    for (const filePath of filesToSeed) {
      try {
        const [content, stats] = await Promise.all([
          readFile(filePath, 'utf-8'),
          stat(filePath),
        ]);
        if (content.trim()) {
          this.syncedContents.set(filePath, content);
          this.syncedMtimes.set(filePath, stats.mtimeMs);
        }
      } catch {
        // File may have disappeared between scan and read — skip
      }
    }

    if (filesToSeed.length > 0) {
      log?.info?.(`[dkg-write-capture] Seeded ${filesToSeed.length} existing file(s) — only deltas will be imported`);
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

    // Compute delta against previous content to avoid reimporting unchanged lines
    const previousContent = this.syncedContents.get(absPath);
    const toImport = previousContent ? computeDelta(previousContent, content) : content;

    if (!toImport.trim()) {
      // No new content — update tracking so we don't re-read next time
      this.syncedMtimes.set(absPath, mtime);
      this.syncedContents.set(absPath, content);
      return;
    }

    // Import only the delta via the daemon's memory pipeline
    await this.client.importMemories(toImport, 'other', { useLlm: true });

    // Update tracking only after successful import — on failure, the next
    // file change will recompute the delta from the old baseline and retry.
    this.syncedMtimes.set(absPath, mtime);
    this.syncedContents.set(absPath, content);
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

/**
 * Compute delta between previous and current file content.
 * Returns lines in `current` not present in `previous`, with
 * markdown section headers preserved for context.
 *
 * On first sync (no previous content), the caller should pass the
 * full content directly — this function is only for subsequent edits.
 */
export function computeDelta(previous: string, current: string): string {
  const prevLines = new Set(previous.split('\n').map(l => l.trimEnd()));
  const currentLines = current.split('\n');

  const deltaLines: string[] = [];
  let lastHeader = '';
  let headerEmitted = false;

  for (const line of currentLines) {
    const trimmed = line.trimEnd();

    // Track markdown headings
    if (/^#{1,6}\s/.test(trimmed)) {
      lastHeader = trimmed;
      headerEmitted = false;
    }

    // Skip empty or unchanged lines
    if (!trimmed || prevLines.has(trimmed)) continue;

    // Prepend existing section header for context (once per section)
    if (lastHeader && !headerEmitted) {
      if (prevLines.has(lastHeader)) {
        deltaLines.push(lastHeader);
      }
      headerEmitted = true;
    }

    deltaLines.push(trimmed);
  }

  return deltaLines.join('\n');
}

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
