// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/ui/http.js';
import type { JpbMonitorJob, JpbMonitorStatus } from '../src/ui/jpb-monitor-api.js';

const mocks = vi.hoisted(() => ({ status: vi.fn(), jobs: vi.fn(), create: vi.fn(), update: vi.fn(), action: vi.fn(), openTab: vi.fn() }));
vi.mock('../src/ui/jpb-monitor-api.js', async (original) => ({
  ...await original<typeof import('../src/ui/jpb-monitor-api.js')>(),
  fetchJpbMonitorStatus: mocks.status, fetchJpbMonitorJobs: mocks.jobs,
  createJpbMonitorJob: mocks.create, updateJpbMonitorJob: mocks.update, actOnJpbMonitorJob: mocks.action,
}));
vi.mock('../src/ui/stores/tabs.js', () => ({ useTabsStore: (selector: (value: unknown) => unknown) => selector({ openTab: mocks.openTab }) }));
import { SourcesPage } from '../src/ui/pages/Sources.js';

const metadata: JpbMonitorStatus = { enabled: true, ownerAddress: '0xowner', minIntervalMs: 1_800_000, maxOrders: 1000, maxBatchSize: 10, mode: 'working-memory-only' };
const job = (overrides: Partial<JpbMonitorJob> = {}): JpbMonitorJob => ({
  id: 'job-a', revision: 3, orderNos: ['46975', '46976'], intervalMs: 1_800_000, batchSize: 2,
  status: 'active', running: false, lastAttemptAt: '2026-10-02T08:00:00Z', lastSuccessAt: '2026-10-02T07:30:00Z', nextDueAt: '2026-10-02T08:30:00Z',
  batches: [{ id: 'batch-a', orderNos: ['46975', '46976'], status: 'success', recordCount: 387, mappedSourceCount: 211, dataKaCount: 2, graphId: 'urn:jpb:batch-a', snapshotRevision: 'fixture-revision-abc' }],
  ...overrides,
});

describe('native Sources page', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.status.mockResolvedValue(metadata);
    mocks.jobs.mockResolvedValue({ jobs: [job()] });
    mocks.action.mockResolvedValue({ job: job({ revision: 4 }) });
    mocks.update.mockResolvedValue({ job: job({ revision: 4 }) });
    mocks.create.mockResolvedValue({ job: job({ id: 'created', revision: 1 }) });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async () => { await act(async () => root.render(React.createElement(SourcesPage))); };
  const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
  const click = async (label: string) => { await act(async () => button(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))); };
  const field = (label: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  const setValue = (label: string, value: string) => act(() => {
    const node = field(label);
    const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = async () => { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };

  it('labels a completed partial fetch and keeps complete-cohort freshness separate', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ freshness: 'partial', lastCompletedAt: '2026-10-06T10:00:00Z', programsMode: 'data-only',
      fetch: { status: 'completed', requestId: 'r', contextGraphId: 'control', executionIri: 'execution', requestAssetName: 'request' },
      coverage: { selectedOrders: 2, returnedOrders: 1, notReturnedOrders: 1, notReturnedOrderNos: ['46976'], complete: false },
      batches: [{ ...job().batches[0], missingOrderNos: ['46976'] }] })] });
    await render();
    expect(container.textContent).toContain('SQL returned 1 / 2 monitored orders');
    expect(container.textContent).toContain('Fetch completed with coverage gaps');
    expect(container.textContent).toContain('Not returned: 46976');
    expect(container.textContent).toContain('Last complete SQL cohort');
    expect(container.textContent).toContain('Last completed check');
    expect(container.textContent).toContain('This does not prove deletion or completion');
  });

  it('opens one shared private data graph while SQL batch checkpoints remain visible', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ contextGraphId: 'owner/jpb-data', graphLayout: 'jpb-data-v1' })] });
    await render();
    expect(container.textContent).toContain('SQL batches are internal checkpoints');
    expect(container.textContent).toContain('New data KAs');
    await click('Open JPB data');
    expect(mocks.openTab).toHaveBeenCalledWith({ id: 'project:owner/jpb-data', label: 'JPB data', closable: true });
    expect(button('Open graph')).toBeUndefined();
  });

  it('shows the actual SQL-worker flow and keeps records separate from data KAs', async () => {
    await render();
    expect(container.textContent).toContain('SQL worker');
    expect(container.textContent).toContain('One reusable Graph Computer fetch Program');
    expect(container.textContent).toContain('Analysis of stored snapshots is a separate operation');
    expect(container.textContent).toContain('Working Memory only');
    expect([...container.querySelectorAll('th')].map((node) => node.textContent)).toContain('Snapshot data KAs');
    expect(container.textContent).toContain('387');
    expect(container.textContent).toContain('211');
    expect(container.textContent).toContain('fixture-revision-abc');
    await click('Open graph');
    expect(mocks.openTab).toHaveBeenCalledWith({ id: 'project:urn:jpb:batch-a', label: 'JPB snapshot', closable: true });
  });
  it('keeps a 1000-order watchlist collapsed and shows actual cadence and verified progress', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ orderNos: Array.from({length:1000},(_,i)=>String(60000-i)) })] });
    await render();
    const details=container.querySelector('details')!;
    expect(details.open).toBe(false);expect(details.querySelector('summary')?.textContent).toBe('Show all 1000 order numbers');
    expect(details.textContent).toContain('59001');
    expect(container.querySelector('.jpb-sources-order-list')?.textContent).not.toContain('59001');
    expect(container.textContent).toContain('30 min after each check');
    expect(container.textContent).toContain('Checked batches: 1 / 1');
  });

  it('shows one fetch Program and accepted request identity without claiming completed SQL', async () => {
    const fetch = { status: 'accepted' as const, requestId: '00000000-0000-4000-8000-000000000004',
      contextGraphId: 'urn:jpb:private-fetch-control', executionIri: 'urn:sr:execution:00000000-0000-4000-8000-000000000004',
      requestAssetName: 'program-asset-' + 'a'.repeat(64) };
    mocks.jobs.mockResolvedValue({ jobs: [job({ programsMode: 'data-only', fetchProgramKaCount: 1, fetch, running: true, freshness: 'never' })] });
    await render();
    const proof = container.querySelector('[aria-label="Fetch Program"]')!;
    expect(container.textContent).toContain('One fetch Program');
    expect(proof.textContent).toContain('Request accepted · ingestion pending');
    expect(proof.textContent).toContain('1 fetch Program source KA');
    expect(proof.textContent).toContain(fetch.requestId); expect(proof.textContent).toContain(fetch.executionIri);
    expect(proof.textContent).not.toContain('Fetch completed');
    expect(proof.textContent).not.toContain('46975'); expect(proof.textContent).not.toContain('46976');
    expect(proof.textContent).not.toContain(fetch.requestAssetName);
    expect(container.textContent).toContain('387'); expect(container.textContent).toContain('211');
    await click('Open fetch control graph');
    expect(mocks.openTab).toHaveBeenCalledWith({ id: 'project:urn:jpb:private-fetch-control', label: 'JPB fetch control', closable: true });
  });
  it('shows the correlated fetch completion without changing snapshot data counts', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ programsMode: 'data-only', fetchProgramKaCount: 1,
      fetch: { status: 'completed', requestId: 'fixture-request', contextGraphId: 'urn:jpb:private-fetch-control',
        executionIri: 'urn:sr:execution:fixture-request', requestAssetName: 'program-asset-fixture', resultAssetName: 'jpb-fetch-result-fixture' } })] });
    await render();
    expect(container.querySelector('[aria-label="Fetch Program"]')!.textContent).toContain('Fetch completed');
    const row = container.querySelector('tbody tr')!;
    expect([...row.querySelectorAll('td')].slice(2,5).map(node => node.textContent)).toEqual(['387','211','2']);
  });
  it('distinguishes an unaccepted data-only job from legacy jobs and preserves their controls', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ programsMode: 'data-only', fetchProgramKaCount: 0 })] });
    await render();
    expect(container.textContent).toContain('Fetch request not accepted yet');
    expect(container.textContent).toContain('0 fetch Program source KAs');
    expect(button('Open fetch control graph')).toBeUndefined();
    mocks.jobs.mockResolvedValue({ jobs: [job({ status: 'paused' })] });
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(container.textContent).toContain('Legacy analysis job');
    expect(container.querySelector('[aria-label="Fetch Program"]')).toBeNull();
    expect(button('Resume').disabled).toBe(false);
  });
  it('distinguishes old SQL capture time from a recently verified graph', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ freshness: 'stale', lastFetchAt: '2026-10-01T08:00:00Z', lastSuccessAt: '2026-10-02T08:00:00Z' })] });
    await render();
    expect(container.textContent).toContain('active · stale');
    expect([...container.querySelectorAll('dt')].map((node) => node.textContent)).toContain('Source fetched');
    expect([...container.querySelectorAll('dt')].map((node) => node.textContent)).toContain('Last complete SQL cohort');
    expect(container.textContent).toContain('not captured in one SQL transaction');
  });
  it('does not claim no source data exists when only part of the cohort has completed', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ running: true, freshness: 'never' })] });
    await render();
    expect(container.textContent).toContain('no complete fetch yet');
    expect(container.textContent).toContain('fixture-revision-abc');
    expect(container.textContent).not.toContain('not fetched yet');
  });
  it('loads immediately in the native React StrictMode shell', async () => {
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(SourcesPage))));
    expect(container.textContent).toContain('fixture-revision-abc');
    expect(container.textContent).not.toContain('Loading monitoring configuration');
  });
  it.each([404, 401, 403])('has no job controls if plugin is absent or denied (%s)', async (code) => {
    mocks.status.mockRejectedValue(new HttpError(code));
    await render();
    expect(container.querySelector('form')).toBeNull();
    expect(mocks.jobs).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });
  it('does not list or change jobs when monitoring is disabled', async () => {
    mocks.status.mockResolvedValue({ ...metadata, enabled: false });
    await render();
    expect(container.textContent).toContain('monitoring is disabled');
    expect(container.querySelector('form')).toBeNull();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });
  it('creates only the selected orders and schedule', async () => {
    await render();
    expect(field('Orders per batch').value).toBe('10');
    setValue('Order numbers (NAF)', '46977,\n46978');
    setValue('Check every (minutes)', '60');
    setValue('Orders per batch', '1');
    await submit();
    expect(mocks.create).toHaveBeenCalledWith({ orderNos: ['46977', '46978'], intervalMs: 3_600_000, batchSize: 1 });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Monitoring job created');
    expect(field('Orders per batch').value).toBe('10');
  });
  it('edits using the revision captured when editing, even if a poll changes the listed job', async () => {
    await render(); await click('Edit');
    expect(field('Orders per batch').disabled).toBe(true);
    mocks.jobs.mockResolvedValue({ jobs: [job({ revision: 7, orderNos: ['99999'] })] });
    await act(async () => vi.advanceTimersByTime(15_000));
    setValue('Order numbers (NAF)', '46980');
    await submit();
    expect(mocks.update).toHaveBeenCalledWith('job-a', { orderNos: ['46980'], intervalMs: 1_800_000 }, 3);
  });
  it('pause and resume preserve the data and use CAS instead of deletion', async () => {
    await render();
    mocks.action.mockResolvedValue({ job: job({ status: 'paused', revision: 4 }) });
    await click('Pause');
    expect(mocks.action).toHaveBeenLastCalledWith('job-a', 'pause', 3);
    expect(button('Check now').disabled).toBe(true);
    expect(container.textContent).toContain('fixture-revision-abc');
    mocks.action.mockResolvedValue({ job: job({ revision: 5 }) });
    await click('Resume');
    expect(mocks.action).toHaveBeenLastCalledWith('job-a', 'resume', 4);
    expect(button('Check now').disabled).toBe(false);
  });
  it('prevents another refresh or editing while a batch check is running', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ running: true })] });
    await render();
    expect(button('Check now').disabled).toBe(true);
    expect(button('Edit').disabled).toBe(true);
    expect(button('Pause').disabled).toBe(false);
  });
  it('requests one refresh and does not claim that ingestion has already completed', async () => {
    await render(); await click('Check now');
    expect(mocks.action).toHaveBeenCalledWith('job-a', 'refresh', 3);
    expect(container.textContent).toContain('The worker will report the result here');
  });
  it('retains the edit on conflicts, does not retry, and exposes no upstream text', async () => {
    await render(); await click('Edit');
    mocks.update.mockRejectedValue(new HttpError(409, 'fixture-secret', { error: 'sql-password=fixture-secret' }));
    setValue('Order numbers (NAF)', '46999'); await submit();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(field('Order numbers (NAF)').value).toBe('46999');
    expect(container.textContent).toContain('job changed');
    expect(container.textContent).not.toContain('fixture-secret');
  });
  it('retains stored batch evidence during transient polling failures', async () => {
    await render();
    mocks.jobs.mockRejectedValue(new HttpError(503, 'secret', { code: 'UPSTREAM_UNAVAILABLE' }));
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(container.textContent).toContain('fixture-revision-abc');
    expect(container.textContent).toContain('UPSTREAM_UNAVAILABLE');
    expect(container.textContent).not.toContain('No monitoring jobs yet');
  });
  it('shows per-batch failures without changing stored counts or exposing raw errors', async () => {
    mocks.jobs.mockResolvedValue({ jobs: [job({ lastError: { code: 'BATCH_FAILED' }, batches: [
      ...job().batches, { id: 'batch-fail', orderNos: ['46977'], status: 'failed', error: { code: 'SQL_READ_FAILED' } },
    ] })] });
    await render();
    expect(container.textContent).toContain('BATCH_FAILED');
    expect(container.textContent).toContain('SQL_READ_FAILED');
    expect(container.textContent).toContain('387');
    expect(container.textContent).toContain('Last verified snapshot');
    expect(container.textContent).toContain('pending or failed check keeps the earlier committed data');
  });
  it('an old in-flight poll cannot overwrite the revision returned by a mutation', async () => {
    await render();
    let resolvePoll!: (value: { jobs: JpbMonitorJob[] }) => void;
    mocks.jobs.mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve; }));
    await act(async () => vi.advanceTimersByTime(15_000));
    mocks.action.mockResolvedValue({ job: job({ status: 'paused', revision: 4 }) });
    await click('Pause');
    await act(async () => resolvePoll({ jobs: [job({ revision: 3 })] }));
    await click('Resume');
    expect(mocks.action).toHaveBeenLastCalledWith('job-a', 'resume', 4);
  });
});
