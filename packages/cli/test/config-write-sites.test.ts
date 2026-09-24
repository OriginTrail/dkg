import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every home-config write is a set of edits, each changing only the value at
// its path (see configEdit). The daemon settings must go through the helpers
// that edit theirs, not through a runtime that would persist the whole
// in-memory config.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

describe('daemon settings writes', () => {
  it('builds the daemon settings with the helpers that persist only their own keys', () => {
    const lifecycle = readFileSync(join(SRC, 'daemon', 'lifecycle.ts'), 'utf8');

    expect(lifecycle).toMatch(/\bcreateDaemonTelemetryRuntime\(\{/);
    expect(lifecycle).toMatch(/\bcreateLlmSettings\(\{ config, memoryManager, log \}\)/);
    expect(lifecycle).toMatch(/\bcreateSharedMemoryTtlSetting\(\{ config, agent \}\)/);
    expect(lifecycle).not.toMatch(/\bcreateTelemetryRuntime\(/);
  });
});
