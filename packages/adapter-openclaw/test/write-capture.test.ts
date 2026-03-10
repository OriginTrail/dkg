import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteCapture, isMemoryPath } from '../src/write-capture.js';
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

  it('should NOT match non-.md files in memory directory', () => {
    expect(isMemoryPath('/workspace/memory/data.json', memDir)).toBe(true); // memDir prefix matches
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
