/**
 * OT-RFC-73 AC1, publisher queue, the retention rows of the §5.1 tagging table: the sweep's verify, wallet-lock and sibling reads and its deletes run inside the claim
 * transaction on the control path (`controlQueue: 'publisher'`, no priority), its candidate scan runs outside the lock on the background lane (explicit `priority: 'background'`,
 * no control tag), whatever the ambient lane, with the control path on and off. Same recorder and the same row assertions as the publisher queue's own oracle
 * (async-lift-queue-boundary-oracle.test.ts); a retention pass is not part of that workload because its lane-trace baseline predates retention.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildStoreControlPath,
  controlStoreOptions,
  externalStorePriorityScheduler,
  selectStoreScheduler,
  setStoreControlPathForTesting,
  type StoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import {
  ADDED_LABELS,
  PUBLISHER_ROW_SOURCES,
  PUBLISHER_TAGGING_ROWS,
  auditPublisherCalls,
  laneTrace,
  resolveLane,
  sourceTrace,
  type RecordedStoreCall,
} from './_helpers/queue-boundary-oracle.js';
import { runPublisherRetentionScenario, runPublisherWorkload, type PublisherStack } from './_helpers/publisher-queue-scenarios.js';

const R = 'publisher.asyncLift.retention.';
const CONTROL_SOURCES = ['verify', 'walletLocks', 'siblings'].map((name) => `${R}${name}`);
const REMOVAL_SOURCES = ['publisher.asyncLift.deleteJob', 'publisher.asyncLift.deleteJobRequest', 'publisher.asyncLift.getStatus'];
const STACKS: readonly PublisherStack[] = ['atomic', 'fallback'];
const AMBIENTS: ReadonlyArray<StoreWorkPriority | undefined> = [undefined, 'normal', 'background'];
const MODES = ['report', 'delete'] as const;

afterEach(() => setStoreControlPathForTesting());

describe('the retention rows of the tagging table', () => {
  it('has a background row for the scan and puts the verify, wallet-lock and sibling reads of the sweep and of bulk clear in the control row', () => {
    const scan = PUBLISHER_TAGGING_ROWS.find((row) => row.id === 'retention-scan')!;
    expect(scan).toMatchObject({ lane: 'background', sources: [`${R}scan`] });
    const control = PUBLISHER_TAGGING_ROWS.find((row) => row.id === 'control-path')!;
    for (const source of [...CONTROL_SOURCES, 'publisher.asyncLift.clear.siblings']) expect(control.sources, source).toContain(source);
    expect(PUBLISHER_ROW_SOURCES.get(`${R}scan`)!.lane).toBe('background');
    for (const source of CONTROL_SOURCES) expect(PUBLISHER_ROW_SOURCES.get(source)!.lane, source).toBe('control');
  });
});

describe.each(STACKS)('publisher retention boundary oracle: %s stack', (stack) => {
  describe.each(MODES)('%s mode', (mode) => {
    it.each(AMBIENTS.map((ambient) => [ambient ?? 'none', ambient] as const))('ambient lane %s: every call of the pass matches its row, with the path on and off', async (_label, ambient) => {
      const run = await runPublisherRetentionScenario(stack, { mode, ambient });
      for (const pathOn of [true, false]) {
        const audit = auditPublisherCalls(run.calls, { pathOn });
        expect(audit.violations, `path ${pathOn ? 'on' : 'off'}`).toEqual([]);
        // not vacuous: the pass reached every row it has, and really judged (and, in delete mode, deleted) jobs
        for (const source of [`${R}scan`, ...CONTROL_SOURCES]) expect(audit.sourcesSeen.has(source), source).toBe(true);
        if (mode === 'delete') for (const source of REMOVAL_SOURCES) expect(audit.sourcesSeen.has(source), source).toBe(true);
      }
      expect(mode === 'delete' ? run.deleted : run.wouldDelete).toBe(4);
      if (mode === 'report') expect(run.calls.some((call) => call.source === 'publisher.asyncLift.deleteJob')).toBe(false);
    });

    it('puts the scan on the background lane without a control tag, and everything else of the sweep on the publisher control instance, under every ambient lane', async () => {
      for (const ambient of AMBIENTS) {
        const run = await runPublisherRetentionScenario(stack, { mode, ambient });
        const sweep = run.calls.filter((call) => call.graphs.length > 0 && call.method !== 'createGraph');
        const lanesOf = (source: string) => [...new Set(sweep.filter((call) => call.source === source).map((call) => resolveLane(call, true)))];
        expect(lanesOf(`${R}scan`), `scan, ambient ${ambient}`).toEqual(['background']);
        for (const source of CONTROL_SOURCES) expect(lanesOf(source), `${source}, ambient ${ambient}`).toEqual(['control:publisher']);
        if (mode === 'delete') for (const source of REMOVAL_SOURCES) expect(lanesOf(source), `${source}, ambient ${ambient}`).toEqual(['control:publisher']);
        const scans = sweep.filter((call) => call.source === `${R}scan`);
        for (const call of scans) expect(call.options).toEqual({ source: `${R}scan`, priority: 'background' });
        for (const call of sweep.filter((c) => CONTROL_SOURCES.includes(c.source!))) expect(call.options).toEqual({ source: call.source, controlQueue: 'publisher' });
      }
    });

    it('with the path off every call resolves exactly as the same call without the tag would: the caller\'s lane, the scan background', async () => {
      for (const ambient of AMBIENTS) {
        const run = await runPublisherRetentionScenario(stack, { mode, ambient });
        for (const call of run.calls.filter((c) => c.source !== undefined && c.graphs.length > 0)) {
          if (call.source === `${R}scan`) expect(resolveLane(call, false)).toBe('background');
          else expect(resolveLane(call, false), `${call.source}, ambient ${ambient}`).toBe(ambient ?? 'normal');
        }
      }
    });

    it('opens no ambient lane scope of its own: the claim transaction and the sweep leave the caller\'s default lane as it was', async () => {
      for (const ambient of AMBIENTS) {
        const run = await runPublisherRetentionScenario(stack, { mode, ambient });
        expect(new Set(run.calls.map((call) => call.ambient))).toEqual(new Set([ambient]));
      }
    });

    it('is routed by the production selector: the control reads and deletes to the publisher instance, the scan to the shared scheduler', async () => {
      const run = await runPublisherRetentionScenario(stack, { mode });
      const on = buildStoreControlPath({ share: 1, publisher: 2 });
      setStoreControlPathForTesting(on);
      for (const call of run.calls) {
        const expected = call.options?.controlQueue === 'publisher' ? on.publisher : externalStorePriorityScheduler;
        expect(selectStoreScheduler(externalStorePriorityScheduler, call.options), `${call.method} ${call.source}`).toBe(expected);
      }
      expect(run.calls.filter((call) => call.source === `${R}scan`).every((call) => selectStoreScheduler(externalStorePriorityScheduler, call.options) === externalStorePriorityScheduler)).toBe(true);
      setStoreControlPathForTesting(buildStoreControlPath({ share: 1, publisher: 0 }));
      for (const call of run.calls) expect(selectStoreScheduler(externalStorePriorityScheduler, call.options)).toBe(externalStorePriorityScheduler);
    });
  });
});

describe('the traces compared with the base SHA leave out only the calls the PR adds', () => {
  it('drops the bulk clear\'s sibling reads from the lane traces and nothing else, and those reads exist in the workload', async () => {
    expect([...ADDED_LABELS]).toEqual(['publisher.asyncLift.clear.siblings']);
    const run = await runPublisherWorkload('atomic');
    const added = run.calls.filter((call) => ADDED_LABELS.has(call.source ?? ''));
    expect(added.length).toBeGreaterThan(0);
    const withoutAdded = run.calls.filter((call) => !ADDED_LABELS.has(call.source ?? ''));
    expect(laneTrace(run.calls)).toEqual(laneTrace(withoutAdded));
    expect(sourceTrace(run.calls)).toEqual(sourceTrace(withoutAdded));
    expect(Object.keys(sourceTrace(run.calls)).some((key) => key.includes('clear.siblings'))).toBe(false);
    // and each of them is a control call that resolves to the caller's lane with the path off, like every tagged call
    for (const call of added) {
      expect(call.options).toEqual(controlStoreOptions('publisher', 'publisher.asyncLift.clear.siblings'));
      expect(resolveLane(call, false)).toBe(call.ambient ?? 'normal');
    }
  });
});

describe('the retention rows of the oracle can fail', () => {
  const call = (over: Partial<RecordedStoreCall>): RecordedStoreCall => ({
    index: 0, method: 'query', graphs: ['job'], source: `${R}scan`, options: { source: `${R}scan`, priority: 'background' }, ambient: undefined, first: 'q', ...over,
  });
  const withOptions = (options: RecordedStoreCall['options']) => call({ options, source: options?.source });
  const violations = (calls: RecordedStoreCall[], pathOn = true) => auditPublisherCalls(calls, { pathOn }).violations;

  it('accepts a background scan and control verify, wallet-lock and sibling reads', () => {
    expect(violations([
      call({}),
      ...CONTROL_SOURCES.map((source) => withOptions(controlStoreOptions('publisher', source))),
    ])).toEqual([]);
  });

  it('fails a scan that was given the control tag, no lane, or a lane other than background', () => {
    expect(violations([withOptions({ source: `${R}scan`, priority: 'background', controlQueue: 'publisher' })]).join('\n')).toMatch(/is not control but carries controlQueue/);
    expect(violations([withOptions({ source: `${R}scan` })]).join('\n')).toMatch(/resolved normal, want background/);
    expect(violations([withOptions({ source: `${R}scan`, priority: 'normal' })]).join('\n')).toMatch(/resolved normal, want background/);
  });

  it('fails a verify, wallet-lock or sibling read that lost the control tag, asks for a lane of its own, or is tagged for the other queue', () => {
    for (const source of CONTROL_SOURCES) {
      expect(violations([withOptions({ source })]).join('\n'), source).toMatch(/needs controlQueue=publisher/);
      expect(violations([withOptions({ source, controlQueue: 'publisher', priority: 'background' })]).join('\n'), source).toMatch(/sets priority=background/);
      expect(violations([withOptions({ source, controlQueue: 'share' })]).join('\n'), source).toMatch(/needs controlQueue=publisher/);
    }
  });

  it('fails a retention call with a label outside the table', () => {
    expect(violations([withOptions({ source: `${R}mystery`, controlQueue: 'publisher' })]).join('\n')).toMatch(/outside the tagging table/);
  });
});
