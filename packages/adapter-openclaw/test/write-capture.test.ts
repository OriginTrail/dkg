import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WriteCapture, isMemoryPath, computeDelta } from '../src/write-capture.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import type { OpenClawPluginApi } from '../src/types.js';

function makeApi(): OpenClawPluginApi {
  return {
    config: {},
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
}

describe('WriteCapture', () => {
  let client: DkgDaemonClient;
  let capture: WriteCapture;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    capture = new WriteCapture(client, { enabled: true, memoryDir: '/workspace/memory' });
  });

  afterEach(() => {
    capture.stop();
    vi.restoreAllMocks();
  });

  it('should register as file-watcher mode (no hook registration)', () => {
    const api = makeApi();
    capture.register(api);

    // No after_tool_call hook registered (not available in OpenClaw)
    expect(api.registerHook).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('file watcher mode'),
    );
  });

  it('stop should clean up timers and watchers', () => {
    capture.stop();
    // Should not throw even when called multiple times
    capture.stop();
  });

  it('syncFile should retry after failed import', async () => {
    const importSpy = vi.spyOn(client, 'importMemories')
      .mockRejectedValueOnce(new Error('daemon offline'))
      .mockResolvedValueOnce({ imported: 1 });

    const tmpDir = resolve(__dirname, '..', 'tmp-test-sync');
    try {
      mkdirSync(tmpDir, { recursive: true });
      const filePath = resolve(tmpDir, 'test.md');
      await writeFile(filePath, '# Test\n- fact 1', 'utf-8');

      // First sync — import fails, tracking should NOT be updated
      await expect(capture.syncFile(filePath)).rejects.toThrow('daemon offline');
      expect(importSpy).toHaveBeenCalledTimes(1);

      // Touch the file so mtime changes
      await new Promise(r => setTimeout(r, 50));
      await writeFile(filePath, '# Test\n- fact 1\n- fact 2', 'utf-8');

      // Second sync — should reimport from old baseline (full content since
      // first import failed), not just the delta "- fact 2"
      await capture.syncFile(filePath);
      expect(importSpy).toHaveBeenCalledTimes(2);
      const secondCallContent = importSpy.mock.calls[1][0];
      // Should contain the full file since tracking wasn't updated after failure
      expect(secondCallContent).toContain('- fact 1');
      expect(secondCallContent).toContain('- fact 2');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('computeDelta', () => {
  it('should return all content when everything is new', () => {
    const prev = '# Heading\n- fact 1';
    const curr = '# Heading\n- fact 1\n- fact 2\n- fact 3';
    const delta = computeDelta(prev, curr);
    expect(delta).toContain('- fact 2');
    expect(delta).toContain('- fact 3');
    expect(delta).not.toContain('- fact 1');
  });

  it('should return empty string when nothing changed', () => {
    const content = '# Heading\n- fact 1\n- fact 2';
    expect(computeDelta(content, content)).toBe('');
  });

  it('should include existing section header as context for new lines', () => {
    const prev = '## Database\n- PostgreSQL';
    const curr = '## Database\n- PostgreSQL\n- SQLite for testing';
    const delta = computeDelta(prev, curr);
    expect(delta).toBe('## Database\n- SQLite for testing');
  });

  it('should not duplicate new section headers', () => {
    const prev = '# Old';
    const curr = '# Old\n## New Section\n- new fact';
    const delta = computeDelta(prev, curr);
    // Both "## New Section" and "- new fact" are new
    expect(delta).toBe('## New Section\n- new fact');
    // Should NOT have "## New Section" duplicated
    expect(delta.split('## New Section').length).toBe(2); // appears once
  });

  it('should handle multiple new sections', () => {
    const prev = '# Root';
    const curr = '# Root\n## A\n- a1\n## B\n- b1';
    const delta = computeDelta(prev, curr);
    expect(delta).toContain('## A');
    expect(delta).toContain('- a1');
    expect(delta).toContain('## B');
    expect(delta).toContain('- b1');
  });

  it('should handle modified lines (old line replaced with new)', () => {
    const prev = '## Config\n- port: 3000';
    const curr = '## Config\n- port: 9200';
    const delta = computeDelta(prev, curr);
    expect(delta).toBe('## Config\n- port: 9200');
    expect(delta).not.toContain('3000');
  });

  it('should skip empty lines', () => {
    const prev = '# H\n\nline1';
    const curr = '# H\n\nline1\n\nline2';
    const delta = computeDelta(prev, curr);
    expect(delta).toBe('# H\nline2');
  });

  it('should handle content with no headings', () => {
    const prev = 'fact 1\nfact 2';
    const curr = 'fact 1\nfact 2\nfact 3';
    const delta = computeDelta(prev, curr);
    expect(delta).toBe('fact 3');
  });

  it('should handle Windows line endings (\\r\\n)', () => {
    const prev = '## A\r\n- old';
    const curr = '## A\r\n- old\r\n- new';
    const delta = computeDelta(prev, curr);
    expect(delta).toBe('## A\n- new');
  });

  it('should treat duplicate existing lines as unchanged', () => {
    // Duplicate lines are in the Set — adding another identical line is ignored.
    // This is a known limitation: duplicate lines are semantically meaningless
    // in memory files, so this is acceptable.
    const prev = '## Items\n- item\n- item';
    const curr = '## Items\n- item\n- item\n- item';
    const delta = computeDelta(prev, curr);
    expect(delta).toBe('');
  });
});

describe('isMemoryPath', () => {
  const memDir = '/workspace/memory';

  it('should match MEMORY.md (exact filename)', () => {
    expect(isMemoryPath('/workspace/MEMORY.md', memDir)).toBe(true);
    expect(isMemoryPath('MEMORY.md', memDir)).toBe(true);
    expect(isMemoryPath('/some/path/MEMORY.md', memDir)).toBe(true);
  });

  it('should match files inside /memory/ directory', () => {
    expect(isMemoryPath('/workspace/memory/patterns.md', memDir)).toBe(true);
    expect(isMemoryPath('/workspace/memory/2026-03-10.md', memDir)).toBe(true);
  });

  it('should NOT match files that merely end with "memory.md"', () => {
    expect(isMemoryPath('/workspace/non-memory.md', memDir)).toBe(false);
    expect(isMemoryPath('/workspace/some_memory.md', memDir)).toBe(false);
  });

  it('should NOT match files in memory-backup (false positive check)', () => {
    expect(isMemoryPath('/workspace/memory-backup/file.md', memDir)).toBe(false);
  });

  it('should match files in configured memoryDir', () => {
    expect(isMemoryPath('/workspace/memory/deep/nested.md', memDir)).toBe(true);
  });

  it('should handle Windows-style backslashes', () => {
    expect(isMemoryPath('C:\\workspace\\memory\\MEMORY.md', 'C:\\workspace\\memory')).toBe(true);
    expect(isMemoryPath('C:\\workspace\\MEMORY.md', 'C:\\workspace\\memory')).toBe(true);
  });

  it('should not match non-.md files under the configured memory directory', () => {
    expect(isMemoryPath('/workspace/memory/data.json', memDir)).toBe(false);
  });

  it('should return false for non-string input', () => {
    expect(isMemoryPath(null, memDir)).toBe(false);
    expect(isMemoryPath(undefined, memDir)).toBe(false);
    expect(isMemoryPath(123, memDir)).toBe(false);
  });

  it('should return false for non-memory .ts files', () => {
    expect(isMemoryPath('/workspace/src/memory.ts', memDir)).toBe(false);
  });
});
