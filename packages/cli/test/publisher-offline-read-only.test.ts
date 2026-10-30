/**
 * #3551: the offline publisher reads leave the node's store file exactly as they found it.
 *
 * `dkg publisher jobs | job | stats` fall back to an inspector that opens the store directly when the daemon's API cannot be reached. A file-backed store
 * writes its in-memory copy back to its file when it closes, so a read that loaded the file before the daemon's latest flush would have put the older
 * queue back. These run each command end to end against a real store file in a node home with no daemon, and check that the file is the same file
 * (a write renames a new one over it) with the same bytes afterwards.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { ApiClient } from '../src/api-client.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

/** Admit one KA publish job per name, through the publisher the daemon uses, into the store file at `path`. */
async function admitJobs(backend: string, path: string, names: readonly string[]): Promise<void> {
  const store = await createTripleStore({ backend, options: { path } });
  let id = '';
  const publisher = new TripleStoreAsyncLiftPublisher(store, { now: () => 1_700_000_000_000, idGenerator: () => id });
  try {
    for (const name of names) {
      id = `job-${name}`;
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name, shareOperationId: `op-${name}` }));
    }
  } finally {
    await store.close();
  }
}

function fileState(path: string) {
  const stat = statSync(path, { bigint: true });
  return { bytes: readFileSync(path), ino: stat.ino, mtimeNs: stat.mtimeNs };
}

describe('the offline publisher reads leave the store file unchanged', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.DKG_HOME;
    home = mkdtempSync(join(tmpdir(), 'dkg-offline-read-'));
    process.env.DKG_HOME = home;   // no daemon.pid: no daemon is running
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => { throw new Error(`process.exit:${code}`); }) as never);
    vi.spyOn(ApiClient, 'connect').mockRejectedValue(new Error('Daemon is not running'));
  });

  afterEach(() => {
    vi.doUnmock('../src/publisher-runner.js');
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.DKG_HOME; else process.env.DKG_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Run one `dkg publisher …` command and return what it printed, parsed. */
  async function run(...args: string[]): Promise<unknown> {
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.map(String).join(' ')); });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const program = new Command().exitOverride();
    registerPublisherCommand(program);
    try {
      await program.parseAsync(['publisher', ...args], { from: 'user' });
    } catch (error) {
      throw new Error(`dkg publisher ${args.join(' ')} failed: ${(error as Error).message}\n${errors.join('\n')}`);
    } finally {
      vi.mocked(console.log).mockRestore();
      vi.mocked(console.error).mockRestore();
    }
    expect(printed).toHaveLength(1);
    return JSON.parse(printed[0]!);
  }

  const ids = (jobs: ReadonlyArray<{ jobId: string }>) => jobs.map(job => job.jobId).sort();
  const READS: ReadonlyArray<readonly [string, readonly string[], (printed: any) => void]> = [
    ['jobs', ['jobs'], printed => expect(ids(printed)).toEqual(['job-a', 'job-b'])],
    ['jobs --all', ['jobs', '--all', '--page-size', '1'], printed => expect(ids(printed)).toEqual(['job-a', 'job-b'])],
    ['jobs --status --page-size', ['jobs', '--status', 'accepted', '--page-size', '1'], printed => expect(printed.jobs).toHaveLength(1)],
    ['job', ['job', 'job-b'], printed => expect(printed).toMatchObject({ jobId: 'job-b', status: 'accepted' })],
    ['job --payload', ['job', 'job-a', '--payload'], printed => expect(printed).toMatchObject({ jobId: 'job-a', payload: null })],
    ['stats', ['stats'], printed => expect(printed).toMatchObject({ accepted: 2 })],
  ];

  describe.each([
    ['the default store (oxigraph-worker, store.nq)', 'oxigraph-worker', undefined],
    ['a configured oxigraph-persistent store', 'oxigraph-persistent', 'queue.nq'],
  ] as const)('%s', (_label, backend, configuredFile) => {
    let storePath: string;

    beforeEach(async () => {
      storePath = join(home, configuredFile ?? 'store.nq');
      if (configuredFile) writeFileSync(join(home, 'config.json'), JSON.stringify({ store: { backend, options: { path: storePath } } }));
      await admitJobs(backend, storePath, ['a', 'b']);
    });

    it.each(READS)('%s prints the queue and leaves the file as it was', async (_name, args, check) => {
      const before = fileState(storePath);
      check(await run(...args));
      expect(fileState(storePath)).toEqual(before);
      expect(readdirSync(home).filter(entry => entry.startsWith('queue.nq') || entry.startsWith('store.nq')))
        .toEqual([configuredFile ?? 'store.nq']);
    });

    it('a read that was open while the daemon flushed a newer queue leaves the newer file in place', async () => {
      // The daemon admits job c and flushes after the inspector has loaded the file, as a stalled or restarting daemon can.
      vi.doMock('../src/publisher-runner.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../src/publisher-runner.js')>();
        return {
          ...actual,
          createPublisherInspector: async (args: Parameters<typeof actual.createPublisherInspector>[0]) => {
            const inspector = await actual.createPublisherInspector(args);
            // The worker store loads its file when its thread starts; its first answer comes after that load.
            await inspector.publisher.getStats();
            await admitJobs(backend, storePath, ['c']);
            return inspector;
          },
        };
      });
      expect(await run('stats')).toMatchObject({ accepted: 2 });   // what the read loaded
      vi.doUnmock('../src/publisher-runner.js');
      expect(await run('stats')).toMatchObject({ accepted: 3 });   // job c is still in the file
    });
  });
});
