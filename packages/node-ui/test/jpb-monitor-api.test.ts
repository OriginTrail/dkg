// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/ui/http.js';
import {
  actOnJpbMonitorJob, createJpbMonitorJob, describeJpbMonitorError,
  fetchJpbMonitorJobs, fetchJpbMonitorStatus, parseJpbMonitorConfig, updateJpbMonitorJob,
  type JpbMonitorStatus,
} from '../src/ui/jpb-monitor-api.js';

const limits: JpbMonitorStatus = {
  enabled: true, ownerAddress: '0xowner', minIntervalMs: 1_800_000,
  maxOrders: 1000, maxBatchSize: 10, mode: 'working-memory-only',
};

afterEach(() => { vi.unstubAllGlobals(); delete window.__DKG_TOKEN__; });

describe('JPB monitor configuration', () => {
  it('preserves selected order identifiers and enforces bounded batches', () => {
    expect(parseJpbMonitorConfig('46975,\n46976 0007', '30', '2', limits)).toEqual({
      orderNos: ['46975', '46976', '0007'], intervalMs: 1_800_000, batchSize: 2,
    });
    const hundred = Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(',');
    expect(parseJpbMonitorConfig(hundred, '60', '10', limits).orderNos).toHaveLength(1000);
    expect(() => parseJpbMonitorConfig(`${hundred},1001`, '60', '10', limits)).toThrow('at most 1000');
    expect(() => parseJpbMonitorConfig(hundred, '60', '9', limits)).toThrow('at least 10');
  });
  it.each([
    ['', '30', '2', 'at least one'], ['1,1', '30', '2', 'only once'],
    ['1', '29', '2', 'at least 30'], ['1', '30.5', '2', 'whole number'],
    ['1', '3e1', '2', 'whole number'], ['1', '9007199254740991', '2', 'whole number'],
    ['1', '30', '0', '1 to 10'], ['1', '30', '11', '1 to 10'], ['1', '30', '2.5', '1 to 10'],
  ])('rejects invalid settings (%s/%s/%s)', (orders, minutes, batch, message) => {
    expect(() => parseJpbMonitorConfig(orders, minutes, batch, limits)).toThrow(message);
  });
  it('honours narrower server limits without exceeding the supported UI limits', () => {
    expect(() => parseJpbMonitorConfig('1,2,3', '60', '2', { ...limits, maxOrders: 2 })).toThrow('at most 2');
    expect(() => parseJpbMonitorConfig('1', '30', '2', { ...limits, minIntervalMs: 3_600_000 })).toThrow('at least 60');
    expect(() => parseJpbMonitorConfig('1', '30', '3', { ...limits, maxBatchSize: 2 })).toThrow('1 to 2');
    expect(() => parseJpbMonitorConfig('1', '1', '2', { ...limits, minIntervalMs: 1 })).toThrow('at least 30');
  });
});

describe('JPB monitor same-origin transport', () => {
  it('uses existing daemon auth and exact revision checks for every mutation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ job: { id: 'job/one', revision: 4 }, jobs: [], ...limits }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    window.__DKG_TOKEN__ = 'fixture-daemon-token';
    await fetchJpbMonitorStatus();
    await fetchJpbMonitorJobs();
    await createJpbMonitorJob({ orderNos: ['46975'], intervalMs: 1_800_000, batchSize: 2 });
    await updateJpbMonitorJob('job/one', { orderNos: ['46976'], intervalMs: 3_600_000 }, 4);
    for (const action of ['pause', 'resume', 'refresh'] as const) await actOnJpbMonitorJob('job/one', action, 5);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/jpb-monitor/status', 'GET'], ['/api/jpb-monitor/jobs', 'GET'],
      ['/api/jpb-monitor/jobs', 'POST'], ['/api/jpb-monitor/jobs/job%2Fone', 'PATCH'],
      ['/api/jpb-monitor/jobs/job%2Fone/pause', 'POST'], ['/api/jpb-monitor/jobs/job%2Fone/resume', 'POST'],
      ['/api/jpb-monitor/jobs/job%2Fone/refresh', 'POST'],
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-daemon-token' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ orderNos: ['46976'], intervalMs: 3_600_000, expectedRevision: 4 });
    for (const [, init] of fetchMock.mock.calls.slice(4)) expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 5 });
  });
  it('retains a conflict status without retrying or displaying upstream secrets', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'REVISION_CONFLICT', error: 'password=fixture-secret' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    let failure: unknown;
    try { await actOnJpbMonitorJob('job', 'pause', 2); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(HttpError);
    expect(describeJpbMonitorError(failure)).toContain('job changed');
    expect(describeJpbMonitorError(failure)).not.toContain('fixture-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeJpbMonitorError(new HttpError(503, 'secret', { code: 'password=secret' }))).not.toContain('secret');
  });
});
