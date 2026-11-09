/**
 * OT-RFC-73 P10b, P11: retention runs only in the daemon's admission instance. Between the verify and the delete of a retention hold the only exclusion is the
 * in-process queue lock, so no other runtime (a standalone agent or library, a worker or runner process, the offline CLI inspector, a script) may build or start a
 * sweep. This test pins who may: every reference to the sweep constructors (the share core's, the publisher core's and the publisher's retention access) and to the
 * starter in shipped source, and how the daemon wires them.
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
/** The code of a file without its comments (block and line), for a rule about calls and not about prose. */
const codeOf = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const filesCalling = (pattern: RegExp): string[] => SOURCES.filter(file => pattern.test(codeOf(file))).sort();

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

  it('the publisher core is constructed in one place: the daemon\'s publisher sweep factory (the definition and the package export aside)', () => {
    expect(filesMatching(/\bcreatePublisherRetention\b/)).toEqual([
      'packages/cli/src/daemon/retention-publisher-sweep.ts',
      'packages/publisher/src/async-lift-retention.ts',
      'packages/publisher/src/index.ts',
    ]);
  });

  it('the publisher queue\'s claim transaction is opened to a sweep in one place: the factory asks the publisher instance it was given for `retentionAccess()`, nobody else does', () => {
    expect(filesCalling(/\.retentionAccess\(/)).toEqual(['packages/cli/src/daemon/retention-publisher-sweep.ts']);
    expect(filesCalling(/\bretentionAccess\(\)\s*[:{]/)).toEqual(['packages/publisher/src/async-lift-publisher-impl.ts', 'packages/publisher/src/async-lift-retention-access.ts']);   // the definitions
  });

  it('the factories and the registry are used by the starter only', () => {
    expect(filesMatching(/\b(?:createShareRetentionSweep|shareRetentionSweepFactory|RETENTION_SWEEP_FACTORIES)\b/)).toEqual([
      'packages/cli/src/daemon/retention-share-sweep.ts',
      'packages/cli/src/daemon/retention-sweeps.ts',
    ]);
    expect(filesMatching(/\b(?:createPublisherRetentionSweep|publisherRetentionSweepFactory)\b/)).toEqual([
      'packages/cli/src/daemon/retention-publisher-sweep.ts',
      'packages/cli/src/daemon/retention-sweeps.ts',
    ]);
  });

  it('the starter is called from the daemon lifecycle and from no other runtime: not the standalone publisher runner or the offline inspector, not another package (the agent, an adapter), not a script', () => {
    expect(filesMatching(/\bstartRetention\b/)).toEqual([
      'packages/cli/src/daemon/lifecycle.ts',
      'packages/cli/src/daemon/retention-sweeps.ts',
    ]);
    for (const other of ['packages/cli/src/publisher-runner.ts', 'packages/cli/src/cli-helpers.ts', 'packages/cli/src/commands/publisher.ts']) {
      expect(read(other), other).not.toMatch(/retention-(?:sweeps|share-sweep|publisher-sweep|timer)|createShareRetention|createPublisherRetention|retentionAccess/);
    }
    // the in-daemon worker is not where retention lives either
    for (const file of SOURCES.filter(name => name.startsWith('packages/cli/src/daemon/worker/'))) expect(read(file), file).not.toMatch(/retention/i);
  });

  it('the daemon starts it as the admission instance, once, with the runtime named', () => {
    const lifecycle = read('packages/cli/src/daemon/lifecycle.ts');
    expect(lifecycle.match(/\bstartRetention\(/g)).toHaveLength(1);
    expect(lifecycle).toMatch(/startRetention\(\{ runtime: 'daemon-admission', settings: retentionSettings, agent, publisher: publisherControl, log \}\)/);
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

  it('hands it the daemon\'s admission instance of the publisher queue: the one built over agent.store with the journal on, before the sweep exists and not the runner\'s', () => {
    const instance = at('const publisherControl = createPublisherControlFromStore(agent.store, {');
    expect(at('daemonRetention = startRetention(')).toBeGreaterThan(instance);
    // the instance is the one that serves the API and the boot backfill; the runner's own instance is made in publisher-runner.ts and is never given to the starter
    expect(lifecycle.slice(instance, instance + 2_500)).toContain('await backfillVmPublishIntentIndexOnBoot(publisherControl, log)');
    expect(lifecycle).toContain('publisherControl,');                                  // handed to the route context
    expect(lifecycle).not.toMatch(/startRetention\([^)]*publisherState/);
    expect(read('packages/cli/src/publisher-runner.ts')).toMatch(/journalWrites: true/);   // the admission instance is the one that writes the journal
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

  it('config.ts stays at the canary budget: the one field line is offset inside the file, and the budget file is not raised for it', () => {
    // The file-size budgets are a one-way ratchet (scripts/audit-file-size.mjs, plan section 4 and 6.2). The canary lowered this budget to the file's
    // exact size (c84fd8b10d), so P10b's single field line has to be offset by a line-neutral rewrite elsewhere in config.ts, not budgeted. Lower this
    // constant when the canary lowers the budget; never raise it. The audit alone cannot catch a hand-edited baseline, it compares to that same file.
    const CANARY_CONFIG_BUDGET = 2688;
    const lines = read('packages/cli/src/config.ts').replace(/\n$/, '').split('\n').length;
    const budget = (JSON.parse(read('scripts/file-size-baseline.json')) as { files: Record<string, number> }).files['packages/cli/src/config.ts'];
    expect(lines).toBeLessThanOrEqual(CANARY_CONFIG_BUDGET);
    expect(budget).toBeLessThanOrEqual(CANARY_CONFIG_BUDGET);
  });
});
