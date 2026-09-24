import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every home-config write declares the keys it owns, and the writer refuses a
// patch that changes any other (see config-file-update.test.ts). The daemon
// settings must go through the helpers that declare theirs, not through a
// runtime that would persist the whole in-memory config.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

describe('daemon settings writes', () => {
  it('builds the daemon settings with the helpers that persist only their own keys', () => {
    const lifecycle = readFileSync(join(SRC, 'daemon', 'lifecycle.ts'), 'utf8');

    expect(lifecycle).toMatch(/\bcreateDaemonTelemetryRuntime\(\{/);
    expect(lifecycle).toMatch(/\bcreateLlmSettings\(\{ config, memoryManager, log \}\)/);
    expect(lifecycle).toMatch(/\bapplySharedMemoryTtl\(\{ config, agent \}, ttlMs\)/);
    expect(lifecycle).not.toMatch(/\bcreateTelemetryRuntime\(/);
  });
});
