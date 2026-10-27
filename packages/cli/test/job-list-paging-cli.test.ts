// SPDX-License-Identifier: Apache-2.0
/**
 * OT-RFC-73 P9b: `--cursor`, `--page-size` and `--all` of `dkg ka share-jobs` and `dkg publisher jobs`, the client path
 * helpers behind them, and the walk both commands share. Without a paging flag the output is exactly what it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import * as configModule from '../src/config.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { parseJobListPagingOptions, readJobList, type JobListPage } from '../src/job-list-paging.js';
import { publisherJobsPath } from '../src/publisher-job-client-paths.js';
import { shareJobsPath } from '../src/share-job-client-paths.js';

const shareJob = (n: number) => ({ jobId: `share-${n}`, state: 'queued', contextGraphId: 'research', assertionName: `paper-${n}` });
const shareLine = (n: number) => `share-${n}\tqueued\tresearch\tpaper-${n}`;

/** A fake daemon: `total` jobs, served in pages of the requested size, with opaque cursors. */
function pagedDaemon<T>(total: number, make: (n: number) => T) {
  const calls: Array<{ cursor?: string; pageSize?: number }> = [];
  const answer = async (request: { cursor?: string; pageSize?: number }): Promise<JobListPage<T>> => {
    calls.push({ cursor: request.cursor, pageSize: request.pageSize });
    const start = request.cursor === undefined ? 0 : Number(request.cursor.replace('c', ''));
    const end = Math.min(total, start + (request.pageSize ?? 100));
    return { jobs: Array.from({ length: end - start }, (_, i) => make(start + i + 1)), nextCursor: end < total ? `c${end}` : null, complete: end >= total };
  };
  return { calls, answer };
}

describe('paging flag parsing', () => {
  it('is null without a paging flag, so the command keeps its unchanged output', () => {
    expect(parseJobListPagingOptions({})).toBeNull();
    expect(parseJobListPagingOptions({ json: true, state: 'queued', limit: '5' })).toBeNull();
  });

  it('reads --cursor, --page-size and --all', () => {
    expect(parseJobListPagingOptions({ cursor: 'v1.x' })).toEqual({ cursor: 'v1.x', pageSize: undefined, all: false });
    expect(parseJobListPagingOptions({ pageSize: '25' })).toEqual({ cursor: undefined, pageSize: 25, all: false });
    expect(parseJobListPagingOptions({ all: true, pageSize: '50' })).toEqual({ cursor: undefined, pageSize: 50, all: true });
  });

  it.each(['0', '-1', '1.5', 'abc', '', '1e3'])('refuses --page-size %s', value => {
    expect(() => parseJobListPagingOptions({ pageSize: value })).toThrow('--page-size must be a positive integer');
  });

  it('refuses --all with --cursor, and --limit with any paging flag', () => {
    expect(() => parseJobListPagingOptions({ all: true, cursor: 'x' })).toThrow('cannot be combined with --cursor');
    for (const flags of [{ all: true }, { cursor: 'x' }, { pageSize: '5' }]) {
      expect(() => parseJobListPagingOptions({ ...flags, limit: '5' })).toThrow('--limit caps the complete list');
    }
  });
});

describe('readJobList', () => {
  const none = async () => { throw new Error('unexpected call'); };

  it('runs only the complete call without paging flags', async () => {
    const result = await readJobList(null, async () => ({ jobs: [1, 2] }), none);
    expect(result).toEqual({ jobs: [1, 2] });
  });

  it('--all pages to the end at the daemon maximum of 1000 and returns every job once, in the shape of the complete answer', async () => {
    const daemon = pagedDaemon(2_500, n => n);
    const result = await readJobList({ all: true }, none, (cursor, pageSize) => daemon.answer({ cursor, pageSize }));
    expect(result).toEqual({ jobs: Array.from({ length: 2_500 }, (_, i) => i + 1) });
    expect(daemon.calls).toEqual([{ pageSize: 1_000 }, { cursor: 'c1000', pageSize: 1_000 }, { cursor: 'c2000', pageSize: 1_000 }]);
  });

  it('--all --page-size sets the page size of every request', async () => {
    const daemon = pagedDaemon(5, n => n);
    const result = await readJobList({ all: true, pageSize: 2 }, none, (cursor, pageSize) => daemon.answer({ cursor, pageSize }));
    expect(result.jobs).toEqual([1, 2, 3, 4, 5]);
    expect(daemon.calls.map(call => call.pageSize)).toEqual([2, 2, 2]);
  });

  it('prints one page, with the position of the next, for --cursor and --page-size', async () => {
    const daemon = pagedDaemon(5, n => n);
    const first = await readJobList({ pageSize: 2, all: false }, none, (cursor, pageSize) => daemon.answer({ cursor, pageSize }));
    expect(first).toEqual({ jobs: [1, 2], nextCursor: 'c2', complete: false });
    const last = await readJobList({ cursor: 'c4', all: false }, none, (cursor, pageSize) => daemon.answer({ cursor, pageSize }));
    expect(last).toEqual({ jobs: [5], nextCursor: null, complete: true });
    expect(daemon.calls).toEqual([{ pageSize: 2 }, { cursor: 'c4' }]);
  });

  it('keeps an incomplete page that holds no job and goes on to the next one', async () => {
    const pages: JobListPage<number>[] = [
      { jobs: [], nextCursor: 'a', complete: false }, { jobs: [7], nextCursor: 'b', complete: false }, { jobs: [], nextCursor: null, complete: true },
    ];
    expect((await readJobList({ all: true }, none, async () => pages.shift()!)).jobs).toEqual([7]);
  });

  it.each([
    ['an unpaged answer (a node that ignored the parameters)', [{ jobs: [1, 2] }], 'does not support --cursor, --page-size or --all'],
    ['an incomplete page without a cursor', [{ jobs: [1], nextCursor: null, complete: false }], 'did not return a new cursor'],
    ['an incomplete page with an empty cursor', [{ jobs: [1], nextCursor: '', complete: false }], 'did not return a new cursor'],
    ['a cursor that does not move on', [{ jobs: [1], nextCursor: 'a', complete: false }, { jobs: [2], nextCursor: 'a', complete: false }], 'stopped after 2 jobs'],
  ] as const)('stops with an error on %s', async (_name, answers, message) => {
    const pages = [...answers] as JobListPage<number>[];
    await expect(readJobList({ all: true }, none, async () => pages.shift()!)).rejects.toThrow(message);
  });

  it('refuses an unpaged answer to a single-page request too', async () => {
    await expect(readJobList({ cursor: 'x', all: false }, none, async () => ({ jobs: [1] }))).rejects.toThrow('does not support');
  });
});

describe('client paths', () => {
  it('shareJobsPath adds the paging parameters after the existing ones and leaves the default URL alone', () => {
    expect(shareJobsPath()).toBe('/api/knowledge-assets/swm/share-jobs');
    expect(shareJobsPath({ contextGraphId: 'cg', state: ['queued', 'failed'], limit: 5 }))
      .toBe('/api/knowledge-assets/swm/share-jobs?contextGraphId=cg&state=queued%2Cfailed&limit=5');
    expect(shareJobsPath({ pageSize: 25 })).toBe('/api/knowledge-assets/swm/share-jobs?pageSize=25');
    expect(shareJobsPath({ contextGraphId: 'cg', state: 'queued', cursor: 'v1.a+b/c=', pageSize: 7 }))
      .toBe('/api/knowledge-assets/swm/share-jobs?contextGraphId=cg&state=queued&cursor=v1.a%2Bb%2Fc%3D&pageSize=7');
    expect(shareJobsPath({ cursor: 'v1.x' })).toBe('/api/knowledge-assets/swm/share-jobs?cursor=v1.x');
  });

  it('publisherJobsPath keeps the default URL and adds the paging parameters', () => {
    expect(publisherJobsPath()).toBe('/api/publisher/jobs');
    expect(publisherJobsPath('failed', 'cg')).toBe('/api/publisher/jobs?status=failed&contextGraphId=cg');
    expect(publisherJobsPath(undefined, undefined, {})).toBe('/api/publisher/jobs');
    expect(publisherJobsPath(undefined, undefined, { pageSize: 25 })).toBe('/api/publisher/jobs?pageSize=25');
    expect(publisherJobsPath('failed', 'cg', { cursor: 'eyJ2IjoxfQ', pageSize: 7 }))
      .toBe('/api/publisher/jobs?status=failed&contextGraphId=cg&cursor=eyJ2IjoxfQ&pageSize=7');
  });

  it('the client sends exactly those paths', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      urls.push(new URL(String(input)).pathname + new URL(String(input)).search);
      return new Response(JSON.stringify({ jobs: [], nextCursor: null, complete: true }), { status: 200 });
    }));
    try {
      const client = new ApiClient(9999, 'token');
      await client.knowledgeAssetShareJobs({ contextGraphId: 'cg', cursor: 'v1.c', pageSize: 3 });
      await client.publisherJobs('failed', 'cg', { cursor: 'abc', pageSize: 3 });
      await client.publisherJobs('failed');
      expect(urls).toEqual([
        '/api/knowledge-assets/swm/share-jobs?contextGraphId=cg&cursor=v1.c&pageSize=3',
        '/api/publisher/jobs?status=failed&contextGraphId=cg&cursor=abc&pageSize=3',
        '/api/publisher/jobs?status=failed',
      ]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('dkg ka share-jobs', () => {
  const lines: string[] = [];
  const errors: string[] = [];
  let knowledgeAssetShareJobs: ReturnType<typeof vi.fn>;

  async function run(...args: string[]): Promise<void> {
    const program = new Command().name('dkg').exitOverride();
    registerKnowledgeAssetCommand(program);
    await program.parseAsync(['node', 'dkg', 'ka', 'share-jobs', ...args]);
  }
  const serve = (total: number) => {
    const daemon = pagedDaemon(total, shareJob);
    knowledgeAssetShareJobs = vi.fn(async (options: { cursor?: string; pageSize?: number; limit?: number }) => (
      options.cursor === undefined && options.pageSize === undefined ? { jobs: Array.from({ length: total }, (_, i) => shareJob(i + 1)) } : daemon.answer(options)));
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetShareJobs } as unknown as ApiClient);
    return daemon;
  };

  beforeEach(() => {
    lines.length = 0;
    errors.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit:1'); }) as typeof process.exit);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('without a paging flag makes the same single call and prints the same lines as before', async () => {
    serve(3);
    await run('-c', 'research', '--state', 'queued', '--limit', '5');
    expect(knowledgeAssetShareJobs).toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'research', state: ['queued'], limit: 5 });
    expect(Object.keys(knowledgeAssetShareJobs.mock.calls[0]![0]).sort()).toEqual(['contextGraphId', 'limit', 'state']);
    expect(lines).toEqual([shareLine(1), shareLine(2), shareLine(3)]);
  });

  it('without a paging flag prints the empty message and the response as JSON, as before', async () => {
    serve(0);
    await run();
    expect(lines).toEqual(['No Knowledge Asset share jobs found.']);
    lines.length = 0;
    await run('--json');
    expect(JSON.parse(lines.join('\n'))).toEqual({ jobs: [] });
  });

  it('--page-size prints the first page and where the next one starts', async () => {
    serve(5);
    await run('-c', 'research', '--page-size', '2');
    expect(knowledgeAssetShareJobs).toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'research', pageSize: 2 });
    expect(lines).toEqual([shareLine(1), shareLine(2), 'Next cursor: c2']);
  });

  it('--cursor prints the page after it, and says so when no further job followed it', async () => {
    serve(5);
    await run('--cursor', 'c3');
    expect(knowledgeAssetShareJobs).toHaveBeenCalledExactlyOnceWith({ cursor: 'c3' });
    expect(lines).toEqual([shareLine(4), shareLine(5), 'No further jobs when this page was read.']);
  });

  it('--cursor --json prints the page with its cursor and complete flag', async () => {
    serve(3);
    await run('--cursor', 'c1', '--page-size', '1', '--json');
    expect(JSON.parse(lines.join('\n'))).toEqual({ jobs: [shareJob(2)], nextCursor: 'c2', complete: false });
  });

  it('an empty page past the end is not reported as "no jobs found"', async () => {
    serve(2);
    await run('--cursor', 'c2');
    expect(lines).toEqual(['No further jobs when this page was read.']);
  });

  it('--all pages through to the end and prints every job, with no footer', async () => {
    const daemon = serve(5);
    await run('--all', '--page-size', '2', '-c', 'research', '--state', 'queued,failed');
    expect(lines).toEqual([1, 2, 3, 4, 5].map(shareLine));
    expect(daemon.calls.map(call => call.cursor)).toEqual([undefined, 'c2', 'c4']);
    expect(knowledgeAssetShareJobs).toHaveBeenCalledWith({ contextGraphId: 'research', state: ['queued', 'failed'], cursor: 'c2', pageSize: 2 });
  });

  it('--all --json prints {jobs} in the shape of the complete answer', async () => {
    serve(3);
    await run('--all', '--page-size', '2', '--json');
    expect(JSON.parse(lines.join('\n'))).toEqual({ jobs: [shareJob(1), shareJob(2), shareJob(3)] });
  });

  it('--all on an empty list says none were found', async () => {
    serve(0);
    await run('--all');
    expect(lines).toEqual(['No Knowledge Asset share jobs found.']);
  });

  it.each([
    [['--all', '--cursor', 'c1'], 'cannot be combined with --cursor'],
    [['--all', '--limit', '5'], '--limit caps the complete list'],
    [['--page-size', '5', '--limit', '5'], '--limit caps the complete list'],
    [['--page-size', '0'], '--page-size must be a positive integer'],
  ])('refuses %j before any request', async (flags, message) => {
    serve(3);
    await expect(run(...flags)).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain(message);
    expect(knowledgeAssetShareJobs).not.toHaveBeenCalled();
  });

  it('reports the daemon error of a bad cursor', async () => {
    serve(3);
    knowledgeAssetShareJobs.mockRejectedValue(new Error('cursor is not a valid share job cursor'));
    await expect(run('--cursor', 'nope')).rejects.toThrow('exit:1');
    expect(errors).toEqual(['cursor is not a valid share job cursor']);
  });
});

describe('dkg publisher jobs', () => {
  const printed: string[] = [];
  const publisherJob = (n: number) => ({ jobId: `lj-${n}`, status: 'accepted', timestamps: { acceptedAt: n } });
  /** The command prints times as ISO strings, the way it always has. */
  const shown = (n: number) => ({ ...publisherJob(n), timestamps: { acceptedAt: new Date(n).toISOString() } });
  let publisherJobs: ReturnType<typeof vi.fn>;

  async function run(...args: string[]): Promise<unknown> {
    const program = new Command().name('dkg').exitOverride();
    registerPublisherCommand(program);
    printed.length = 0;
    await program.parseAsync(['node', 'dkg', 'publisher', 'jobs', ...args]);
    return JSON.parse(printed.join('\n'));
  }
  const serve = (total: number) => {
    const daemon = pagedDaemon(total, publisherJob);
    publisherJobs = vi.fn(async (_status?: string, _graph?: string, page?: { cursor?: string; pageSize?: number }) => (
      page ? daemon.answer(page) : { jobs: Array.from({ length: total }, (_, i) => publisherJob(i + 1)) }));
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ publisherJobs } as unknown as ApiClient);
    return daemon;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit:1'); }) as typeof process.exit);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('without a paging flag makes the same single call and prints the bare array as before', async () => {
    serve(3);
    expect(await run('--status', 'accepted', '--context-graph', 'cg')).toEqual([1, 2, 3].map(shown));
    expect(publisherJobs).toHaveBeenCalledExactlyOnceWith('accepted', 'cg');
  });

  it('--page-size prints an object with the page and where the next one starts', async () => {
    serve(5);
    expect(await run('--page-size', '2', '--status', 'accepted')).toEqual({ jobs: [shown(1), shown(2)], nextCursor: 'c2', complete: false });
    expect(publisherJobs).toHaveBeenCalledExactlyOnceWith('accepted', undefined, { cursor: undefined, pageSize: 2 });
  });

  it('--cursor prints the last page as complete', async () => {
    serve(5);
    expect(await run('--cursor', 'c3')).toEqual({ jobs: [shown(4), shown(5)], nextCursor: null, complete: true });
  });

  it('--all pages through to the end and prints the bare array of every job', async () => {
    const daemon = serve(5);
    expect(await run('--all', '--page-size', '2')).toEqual([1, 2, 3, 4, 5].map(shown));
    expect(daemon.calls.map(call => call.cursor)).toEqual([undefined, 'c2', 'c4']);
  });

  it.each([
    [['--all', '--cursor', 'c1'], 'cannot be combined with --cursor'],
    [['--page-size', 'x'], '--page-size must be a positive integer'],
  ])('refuses %j before any request', async (flags, message) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    serve(3);
    await expect(run(...flags)).rejects.toThrow('exit:1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(publisherJobs).not.toHaveBeenCalled();
  });

  describe('with the daemon stopped', () => {
    const inspectorOf = (total: number) => {
      const daemon = pagedDaemon(total, publisherJob);
      const list = vi.fn(async () => Array.from({ length: total }, (_, i) => publisherJob(i + 1)));
      const listPage = vi.fn(async (request: { cursor?: string; limit?: number }) => daemon.answer({ cursor: request.cursor, pageSize: request.limit }));
      const stop = vi.fn(async () => undefined);
      vi.spyOn(ApiClient, 'connect').mockRejectedValue(new Error('Daemon is not running'));
      vi.spyOn(configModule, 'loadConfig').mockResolvedValue({} as never);
      vi.doMock('../src/publisher-runner.js', () => ({ createPublisherInspector: async () => ({ publisher: { list, listPage }, stop }) }));
      return { list, listPage, stop };
    };
    afterEach(() => { vi.doUnmock('../src/publisher-runner.js'); });

    it('lists the same way as before without a paging flag', async () => {
      const inspector = inspectorOf(3);
      expect(await run('--status', 'accepted')).toEqual([1, 2, 3].map(shown));
      expect(inspector.list).toHaveBeenCalledExactlyOnceWith({ status: 'accepted' });
      expect(inspector.listPage).not.toHaveBeenCalled();
    });

    it('pages the publisher it opened with --page-size, --cursor and --all, and closes it', async () => {
      const inspector = inspectorOf(5);
      expect(await run('--page-size', '2')).toEqual({ jobs: [shown(1), shown(2)], nextCursor: 'c2', complete: false });
      expect(inspector.listPage).toHaveBeenLastCalledWith({ cursor: undefined, limit: 2 });
      expect(await run('--all', '--page-size', '2', '--status', 'accepted')).toEqual([1, 2, 3, 4, 5].map(shown));
      expect(inspector.listPage).toHaveBeenLastCalledWith({ status: 'accepted', cursor: 'c4', limit: 2 });
      expect(inspector.list).not.toHaveBeenCalled();
      expect(inspector.stop).toHaveBeenCalledTimes(2);
    });
  });
});
