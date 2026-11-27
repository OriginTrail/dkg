import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryConfigError, resolveQueryConfig } from '../src/read-graphs-config.js';
import {
  READ_GRAPHS_FIRST_RECOGNIZING_RELEASE,
  assertQueryConfigFitsNode,
  assertRollbackTargetRecognizesReadGraphs,
  readGraphRollbackTarget,
  resolveQueryConfigOrExit,
  rollbackTargetRecognizesReadGraphs,
} from '../src/update/read-graph-rollback-target.js';

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.DKG_HOME;
  home = await mkdtemp(join(tmpdir(), 'dkg-read-graph-rollback-'));
  process.env.DKG_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const BUILD = resolveQueryConfig({ readGraphs: { contextGraphs: { notes: { layers: { 'verifiable-memory': 'build' } } } } });
const OFF = resolveQueryConfig({ readGraphs: 'off', viewSemantics: 'merged' });

/** A built slot in the git layout: `releases/<slot>` with the CLI entry point and its package version. */
async function slot(name: 'a' | 'b', version: string, options: { guard?: 'git' | 'npm' } = {}): Promise<string> {
  const dir = join(home, 'releases', name);
  await mkdir(join(dir, 'packages', 'cli', 'dist'), { recursive: true });
  await writeFile(join(dir, 'packages', 'cli', 'dist', 'cli.js'), '');
  await writeFile(join(dir, 'packages', 'cli', 'package.json'), JSON.stringify({ version }));
  const guard = options.guard === 'git'
    ? join(dir, 'packages', 'storage', 'dist')
    : options.guard === 'npm' ? join(dir, 'node_modules', '@origintrail-official', 'dkg-storage', 'dist') : undefined;
  if (guard) {
    await mkdir(guard, { recursive: true });
    await writeFile(join(guard, 'read-graph-partition-store.js'), '');
  }
  return dir;
}

async function activate(name: 'a' | 'b'): Promise<void> {
  await mkdir(join(home, 'releases', name), { recursive: true });
  await symlink(join(home, 'releases', name), join(home, 'releases', 'current'));
}

async function refusal(role: 'core' | 'edge'): Promise<QueryConfigError | undefined> {
  try {
    await assertRollbackTargetRecognizesReadGraphs(BUILD, role);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(QueryConfigError);
    return error as QueryConfigError;
  }
}

describe('read graphs and the Edge rollback target', () => {
  it('refuses read graphs while the recorded previous version is older than the first recognizing release', async () => {
    await writeFile(join(home, 'previous-version'), '10.1.0\n');
    const error = await refusal('edge');
    expect(error?.issues).toEqual([{
      key: 'query.readGraphs',
      message: `must be "off" while the rollback target (${join(home, 'previous-version')}: 10.1.0) is older than `
        + `${READ_GRAPHS_FIRST_RECOGNIZING_RELEASE}, the first release that recognizes read graphs`,
    }]);
    await expect(assertRollbackTargetRecognizesReadGraphs(OFF, 'edge')).resolves.toBeUndefined();
  });

  it('counts a prerelease or an unreadable version as older, and the first release or later as recognizing', async () => {
    for (const [version, refused] of [
      ['10.0.27', true], ['10.1.0', true], ['10.1.1-rc.1', true], ['not-a-version', true],
      ['10.1.1', false], ['10.1.2', false], ['10.2.0', false], ['11.0.0-beta.1', false],
    ] as const) {
      await writeFile(join(home, 'previous-version'), version);
      expect(Boolean(await refusal('edge')), version).toBe(refused);
    }
  });

  it('accepts read graphs when nothing is recorded to roll back to', async () => {
    expect(await readGraphRollbackTarget('edge')).toEqual({ kind: 'none' });
    await writeFile(join(home, 'previous-version'), '  \n');
    expect(await readGraphRollbackTarget('edge')).toEqual({ kind: 'none' });
    expect(await refusal('edge')).toBeUndefined();
  });
});

describe('read graphs and the Core rollback target', () => {
  it('reads the other slot, and refuses read graphs while it holds an older release', async () => {
    await activate('a');
    await slot('b', '10.1.0');
    expect(await readGraphRollbackTarget('core')).toEqual({ kind: 'release', source: 'slot b', version: '10.1.0', holdsPartitionGuard: false });
    expect((await refusal('core'))?.issues[0]?.message).toContain('(slot b: 10.1.0)');
  });

  it('accepts a slot whose build holds the partition guard, whatever version it reports', async () => {
    await activate('a');
    await slot('b', '10.1.0', { guard: 'git' });
    expect(await refusal('core')).toBeUndefined();
    await rm(join(home, 'releases', 'b'), { recursive: true });
    await slot('b', '10.1.0', { guard: 'npm' });
    expect(await refusal('core')).toBeUndefined();
  });

  it('accepts read graphs when the slots are not set up or the other slot has no build', async () => {
    expect(await readGraphRollbackTarget('core')).toEqual({ kind: 'none' });
    await activate('b');
    expect(await readGraphRollbackTarget('core')).toEqual({ kind: 'none' });
    await mkdir(join(home, 'releases', 'a'), { recursive: true });
    expect(await refusal('core')).toBeUndefined();
    await slot('a', '10.1.1');
    expect(rollbackTargetRecognizesReadGraphs(await readGraphRollbackTarget('core'))).toBe(true);
  });
});

describe('read graphs on a node that starts from a public checkpoint', () => {
  it('refuses settings that keep a read graph, and accepts settings that keep none', async () => {
    // Nothing to roll back to: only the checkpoint decides.
    const refused = await assertQueryConfigFitsNode(BUILD, 'edge', true).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(QueryConfigError);
    expect((refused as QueryConfigError).issues).toEqual([{
      key: 'query.readGraphs',
      message: 'must be "off" on a node that starts from a public checkpoint, whose store the checkpoint builds',
    }]);
    for (const config of [OFF, resolveQueryConfig({})]) await expect(assertQueryConfigFitsNode(config, 'edge', true)).resolves.toBeUndefined();
    // Without a checkpoint, the same settings pass to the rollback-target check.
    await expect(assertQueryConfigFitsNode(BUILD, 'edge', false)).resolves.toBeUndefined();
    await writeFile(join(home, 'previous-version'), '10.1.0\n');
    await expect(assertQueryConfigFitsNode(BUILD, 'edge', false)).rejects.toBeInstanceOf(QueryConfigError);
  });
});

describe('dkg start', () => {
  it('logs every offending key and stops the start', async () => {
    await writeFile(join(home, 'previous-version'), '10.0.27');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    const lines: string[] = [];
    try {
      await expect(resolveQueryConfigOrExit({ query: { readGraphs: 'serve' } }, (line) => lines.push(line))).rejects.toThrow('exit 1');
      expect(lines[0]).toBe('[QUERY-CONFIG] 1 validation error(s) - refusing to start.');
      expect(lines[1]).toMatch(/^ {2}query\.readGraphs: must be "off" while the rollback target/);
      lines.length = 0;
      await expect(resolveQueryConfigOrExit({ query: { viewSemantics: 'joined' } }, (line) => lines.push(line))).rejects.toThrow('exit 1');
      expect(lines[1]).toBe('  query.viewSemantics: must be one of "per-asset", "merged" (got "joined")');
      await expect(resolveQueryConfigOrExit({ query: { readGraphs: 'off' } }, (line) => lines.push(line)))
        .resolves.toEqual(resolveQueryConfig({ readGraphs: 'off' }));
    } finally {
      exit.mockRestore();
    }
  });
});
