import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Census of the home-config write sites. Every write is a patch of the keys its
// caller owns (see DkgConfigFilePatch), so a new call site belongs on this list
// with the keys it writes, and a whole-config write cannot slip in unreviewed.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const WRITE_SITES: Record<string, string> = {
  'home-config-file.ts': 'the writer itself',
  'config.ts': 'DkgHomeFiles.updateConfigFile and its module wrapper',
  'commands/context-graph.ts': 'contextGraphs',
  'commands/init.ts': "the init wizard's answers and auth.enabled",
  'commands/knowledge.ts': 'contextGraphs',
  'commands/publisher.ts': 'the publisher keys the command manages',
  'store-wizard.ts': 'store',
  'daemon/local-agents.ts': 'one localAgentIntegrations entry',
  'daemon/runtime-settings.ts': 'telemetry.enabled, llm, and sharedMemoryTtlMs with workspaceTtlMs',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('home config write sites', () => {
  it('writes the home config only from the reviewed call sites', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => /\bupdate(?:Home)?ConfigFile\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split(sep).join('/'));

    expect(callers.sort()).toEqual(Object.keys(WRITE_SITES).sort());
  });

  it('builds the daemon settings with the helpers that persist only their own keys', () => {
    const lifecycle = readFileSync(join(SRC, 'daemon', 'lifecycle.ts'), 'utf8');

    expect(lifecycle).toMatch(/\bcreateDaemonTelemetryRuntime\(\{/);
    expect(lifecycle).toMatch(/\bcreateLlmSettings\(\{ config, memoryManager, log \}\)/);
    expect(lifecycle).toMatch(/\bapplySharedMemoryTtl\(\{ config, agent \}, ttlMs\)/);
    expect(lifecycle).not.toMatch(/\bcreateTelemetryRuntime\(/);
  });
});
