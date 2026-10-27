/**
 * OT-RFC-73 P10b: retention runs only in the daemon's admission instance. Between the verify and the delete of a retention hold the only exclusion is the
 * in-process queue lock, so no other runtime (a standalone agent or library, a worker or runner process, the offline CLI inspector, a script) may build or start a
 * sweep. This test pins who may: every reference to the sweep constructors and to the starter in shipped source, and how the daemon wires them.
 *
 * It reads source across packages on purpose. A new caller makes this test fail; whoever adds one must say, in the allow-list below, why that runtime is safe.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', '.git', 'coverage']);
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sh)$/;

/** Shipped source: `packages/<name>/src`, `scripts` and `devnet`, without test directories, build output or dependencies. */
function shippedSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIPPED_DIRS.has(name)) continue;
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (SOURCE_FILE.test(name) && !/\.(test|spec)\./.test(name)) files.push(relative(ROOT, path));
    }
  };
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    try { walk(join(ROOT, 'packages', pkg, 'src')); } catch { /* a package without src */ }
  }
  for (const extra of ['scripts', 'devnet']) {
    try { walk(join(ROOT, extra)); } catch { /* absent */ }
  }
  return files;
}

const SOURCES = shippedSources();
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf-8');
const filesMatching = (pattern: RegExp): string[] => SOURCES.filter(file => pattern.test(read(file))).sort();

describe('who may build or start a sweep', () => {
  it('scans a real tree (the guard below would pass vacuously on an empty one)', () => {
    expect(SOURCES.length).toBeGreaterThan(1500);
    expect(SOURCES).toContain('packages/cli/src/daemon/lifecycle.ts');
    expect(SOURCES).toContain('packages/cli/src/publisher-runner.ts');
    expect(SOURCES.some(file => file.startsWith('scripts/'))).toBe(true);
  });

  it('the share core is constructed in one place: the daemon\'s share sweep factory (the definition and the package export aside)', () => {
    expect(filesMatching(/\bcreateShareRetention\b/)).toEqual([
      'packages/cli/src/daemon/retention-share-sweep.ts',
      'packages/publisher/src/async-promote-retention.ts',
      'packages/publisher/src/index.ts',
    ]);
  });

  it('the factory and the registry are used by the starter only', () => {
    expect(filesMatching(/\b(?:createShareRetentionSweep|shareRetentionSweepFactory|RETENTION_SWEEP_FACTORIES)\b/)).toEqual([
      'packages/cli/src/daemon/retention-share-sweep.ts',
      'packages/cli/src/daemon/retention-sweeps.ts',
    ]);
  });

  it('the starter is called from the daemon lifecycle and from no other runtime: not the standalone publisher runner or the offline inspector, not another package (the agent, an adapter), not a script', () => {
    expect(filesMatching(/\bstartRetention\b/)).toEqual([
      'packages/cli/src/daemon/lifecycle.ts',
      'packages/cli/src/daemon/retention-sweeps.ts',
    ]);
    for (const other of ['packages/cli/src/publisher-runner.ts', 'packages/cli/src/cli-helpers.ts', 'packages/cli/src/commands/publisher.ts']) {
      expect(read(other), other).not.toMatch(/retention-(?:sweeps|share-sweep|timer)|createShareRetention/);
    }
    // the in-daemon worker is not where retention lives either
    for (const file of SOURCES.filter(name => name.startsWith('packages/cli/src/daemon/worker/'))) expect(read(file), file).not.toMatch(/retention/i);
  });

  it('the daemon starts it as the admission instance, once, with the runtime named', () => {
    const lifecycle = read('packages/cli/src/daemon/lifecycle.ts');
    expect(lifecycle.match(/\bstartRetention\(/g)).toHaveLength(1);
    expect(lifecycle).toMatch(/startRetention\(\{ runtime: 'daemon-admission', settings: retentionSettings, agent, log \}\)/);
    expect(lifecycle).not.toMatch(/runtime: '(?:standalone-agent|worker-process|publisher-runner|offline-inspector|script)'/);
  });
});

describe('how the daemon wires it', () => {
  const lifecycle = read('packages/cli/src/daemon/lifecycle.ts');
  const at = (needle: string): number => {
    const index = lifecycle.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it('validates the section at boot, before anything starts', () => {
    expect(at('resolveRetentionConfig(config.queueRetention)')).toBeLessThan(at('const startPostApiPublishing'));
    expect(at('resolveRetentionConfig(config.queueRetention)')).toBeLessThan(at('DKGAgent.create(agentConfig)'));
  });

  it('starts it after the API is listening, next to the promote worker, and not before the queue is configured', () => {
    const start = at('daemonRetention = startRetention(');
    expect(start).toBeGreaterThan(at('const startPostApiPublishing'));
    expect(start).toBeGreaterThan(at('promoteWorkerLifecycle = startPromoteWorkerDaemonLifecycle('));
    expect(start).toBeGreaterThan(at('agent.configurePromoteQueue(promoteQueuePolicy)'));
  });

  it('stops it in the shutdown, before the producers are quiesced and the agent stops', () => {
    expect(at('await daemonRetention?.stop()')).toBeLessThan(at('buildProducerQuiescentTeardownSteps('));
  });

  it('feeds the periodic usage line from it', () => {
    const usageLog = lifecycle.slice(at('startAsyncAdmissionUsageLog({'), at('startAsyncAdmissionUsageLog({') + 600);
    expect(usageLog).toContain('retention: () => daemonRetention?.usage() ?? []');
  });

  it('dkg start refuses a bad section before it spawns anything', () => {
    const command = read('packages/cli/src/commands/lifecycle.ts');
    expect(command).toContain('resolveRetentionConfigOrExit(bootConfig.queueRetention');
  });

  it('config.ts carries one field and nothing else of it', () => {
    const config = read('packages/cli/src/config.ts');
    expect(config.match(/retention-config/g)).toHaveLength(1);
    expect(config).toContain("queueRetention?: import('./retention-config.js').RetentionConfigInput;");
  });
});
