// A real V8 profile through the node's recorder. The recording runs in a child
// process (see the fixture for why); this file checks what it wrote.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/cpu-profile-real.fixture.ts', import.meta.url));
const PREFIX = 'CPU_PROFILE_FIXTURE ';

interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  children?: number[];
}

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cpu-profile-real-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('writes a loadable profile with function names and leaves no session or listener open', async () => {
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), FIXTURE, directory], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(run.status, run.stderr + run.stdout).toBe(0);
  const line = run.stdout.split('\n').find((text) => text.startsWith(PREFIX));
  expect(line, run.stdout).toBeDefined();
  const report = JSON.parse(line!.slice(PREFIX.length)) as {
    result: { path: string; seconds: number; recordedMs: number; bytes: number; stoppedEarly: boolean };
    failure: string;
    closed: boolean[];
    listener: string | null;
  };

  // Both sessions, the recorded one and the one whose write failed, are closed,
  // and no inspector port was ever opened.
  expect(report.failure).toBe('EEXIST');
  expect(report.closed).toEqual([true, true]);
  expect(report.listener).toBeNull();

  expect(report.result).toMatchObject({ seconds: 1, stoppedEarly: false });
  expect(report.result.recordedMs).toBeGreaterThanOrEqual(900);
  expect(basename(report.result.path)).toMatch(/^cpu-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.cpuprofile$/);
  expect((await readdir(directory)).sort()).toEqual(['blocked', basename(report.result.path)].sort());
  expect((await stat(report.result.path)).size).toBe(report.result.bytes);

  // The shape DevTools loads: a node tree, and one time delta per sample.
  const profile = JSON.parse(await readFile(report.result.path, 'utf8')) as {
    nodes: CpuProfileNode[];
    startTime: number;
    endTime: number;
    samples: number[];
    timeDeltas: number[];
  };
  expect(profile.endTime).toBeGreaterThan(profile.startTime);
  expect(profile.samples.length).toBeGreaterThan(0);
  expect(profile.timeDeltas).toHaveLength(profile.samples.length);
  const ids = new Set(profile.nodes.map((node) => node.id));
  expect(profile.samples.every((sample) => ids.has(sample))).toBe(true);
  expect(profile.nodes.flatMap((node) => node.children ?? []).every((child) => ids.has(child))).toBe(true);
  expect(profile.nodes.map((node) => node.callFrame.functionName)).toContain('cpuProfileFixtureBusyLoop');
}, 90_000);
