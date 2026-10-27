/**
 * OT-RFC-73 AC2, publisher queue: lane-trace equivalence with the control path OFF.
 *
 * The same scripted workload ran on the base SHA (origin/testnet-canary with P3 and P7, before the publisher
 * tagging) and its trace was recorded in `_helpers/publisher-lane-trace-base.json`: how many store calls resolved to
 * each (lane, operation family). With the path off the candidate must produce the equal multiset, on both store
 * stacks and with and without a non-default ambient lane, because tagging only adds `controlQueue` and a source and
 * never a priority, and a tagged call resolves exactly like the same call without the tag. The resolved lane is the
 * routing-tested resolution of the recorded options and the ambient default (explicit ?? ambient ?? normal; the
 * production selector is exercised against the same calls below). Labels the PR adds map to their base label first.
 *
 * The family multiset cannot see a change that keeps every family's count (two sites of one family exchanging lanes
 * or labels, a site moving while another moves the other way). So the same workload is also compared site by site:
 * the multiset of (resolved lane, source label), against a second golden recorded by the same recorder on the same
 * base SHA (`publisher-lane-trace-base-by-source.json`, which folds to the family golden exactly).
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildStoreControlPath,
  externalStorePriorityScheduler,
  selectStoreScheduler,
  setStoreControlPathForTesting,
  type StoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import {
  LABEL_TO_BASE,
  familyOfSourceTrace,
  laneTrace,
  sourceTrace,
  type RecordedStoreCall,
} from './_helpers/queue-boundary-oracle.js';
import { runPublisherWorkload, type PublisherStack } from './_helpers/publisher-queue-scenarios.js';

const BASE = JSON.parse(readFileSync(new URL('./_helpers/publisher-lane-trace-base.json', import.meta.url), 'utf8')) as
  Record<string, Record<string, number> | string>;

const BASE_BY_SOURCE = JSON.parse(
  readFileSync(new URL('./_helpers/publisher-lane-trace-base-by-source.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, number> | string>;

const STACKS: readonly PublisherStack[] = ['atomic', 'fallback'];
const AMBIENTS: ReadonlyArray<StoreWorkPriority | undefined> = [undefined, 'background'];

afterEach(() => setStoreControlPathForTesting());

describe('publisher queue lane trace with the control path off (AC2)', () => {
  it.each(STACKS.flatMap((stack) => AMBIENTS.map((ambient) => [stack, ambient] as const)))(
    '%s stack, ambient %s: the same multiset of (lane, operation family) as the base SHA',
    async (stack, ambient) => {
      const run = await runPublisherWorkload(stack, { ambient });
      expect(laneTrace(run.calls)).toEqual(BASE[`${stack}/${ambient ?? 'none'}`]);
    },
  );

  it.each(STACKS.flatMap((stack) => AMBIENTS.map((ambient) => [stack, ambient] as const)))(
    '%s stack, ambient %s: the same multiset of (lane, source label) as the base SHA, site by site',
    async (stack, ambient) => {
      const run = await runPublisherWorkload(stack, { ambient });
      expect(sourceTrace(run.calls)).toEqual(BASE_BY_SOURCE[`${stack}/${ambient ?? 'none'}`]);
    },
  );

  it('keeps the two goldens in step: the per-site golden folds to the family golden', () => {
    const keys = Object.keys(BASE).filter((key) => !key.startsWith('_'));
    expect(keys).toHaveLength(STACKS.length * AMBIENTS.length);
    expect(Object.keys(BASE_BY_SOURCE).filter((key) => !key.startsWith('_'))).toEqual(keys);
    for (const key of keys) {
      expect(familyOfSourceTrace(BASE_BY_SOURCE[key] as Record<string, number>), key).toEqual(BASE[key]);
    }
  });

  it('keeps the bulk retry\'s listing the one site whose label changed: base list = list + retryList', async () => {
    for (const stack of STACKS) {
      const run = await runPublisherWorkload(stack);
      const own = (label: string) => run.calls.filter((call) => call.source === label).length;
      const baseList = (BASE_BY_SOURCE[`${stack}/none`] as Record<string, number>)['normal publisher.asyncLift.list'];
      expect(own('publisher.asyncLift.retryList'), stack).toBeGreaterThan(0);
      expect(own('publisher.asyncLift.list') + own('publisher.asyncLift.retryList'), stack).toBe(baseList);
    }
  });

  it('maps the labels the PR adds to the base label of the same operation', () => {
    expect(LABEL_TO_BASE).toEqual({
      'publisher.asyncLift.retryList': 'publisher.asyncLift.list',
      'publisher.asyncLift.stats': 'publisher.asyncLift.list',
    });
  });

  it('adds nothing but the queue tag and the source to a control call: no priority, no other option', async () => {
    for (const stack of STACKS) {
      const run = await runPublisherWorkload(stack);
      const tagged = run.calls.filter((call) => call.options?.controlQueue !== undefined);
      expect(tagged.length).toBeGreaterThan(100);
      for (const call of tagged) {
        expect(call.options, `${call.method} ${call.source}`).toEqual({ source: call.source, controlQueue: 'publisher' });
      }
    }
  });

  it('keeps every call on the shared scheduler when the publisher\'s path is off, as the production selector decides', async () => {
    const run = await runPublisherWorkload('atomic');
    for (const path of [{}, buildStoreControlPath({ share: 1, publisher: 0 })]) {
      setStoreControlPathForTesting(path);
      for (const call of run.calls) {
        expect(selectStoreScheduler(externalStorePriorityScheduler, call.options), `${call.method} ${call.source}`)
          .toBe(externalStorePriorityScheduler);
      }
    }
  });

  it('notices what the family multiset cannot: two sites of one family exchanging lanes (the per-site comparison can fail)', () => {
    const at = (index: number, name: string, ambient: StoreWorkPriority | undefined): RecordedStoreCall => ({
      index, method: 'query', graphs: ['job'], source: `publisher.asyncLift.${name}`,
      options: { source: `publisher.asyncLift.${name}`, controlQueue: 'publisher' }, ambient, first: 'q',
    });
    // Site A runs on the normal lane and site B on the background lane; a change that swaps them keeps every
    // (lane, family) count.
    const before = [at(0, 'getStatus', undefined), at(1, 'lookupVmPublishIntent', 'background')];
    const swapped = [at(0, 'getStatus', 'background'), at(1, 'lookupVmPublishIntent', undefined)];
    expect(laneTrace(swapped)).toEqual(laneTrace(before));
    expect(sourceTrace(swapped)).not.toEqual(sourceTrace(before));
    // Two sites exchanging their labels keep every count by lane and by family as well.
    const relabelled = [at(0, 'lookupVmPublishIntent', undefined), at(1, 'getStatus', 'background')];
    expect(laneTrace(relabelled)).toEqual(laneTrace(before));
    expect(sourceTrace(relabelled)).not.toEqual(sourceTrace(before));
  });

  it('would notice a tag that moves a call to a priority (the comparison can fail)', () => {
    const call: RecordedStoreCall = {
      index: 0, method: 'query', graphs: ['job'], source: 'publisher.asyncLift.getStatus',
      options: { source: 'publisher.asyncLift.getStatus', controlQueue: 'publisher' }, ambient: undefined, first: 'q',
    };
    const base = laneTrace([call]);
    expect(base).toEqual({ 'normal publisher.asyncLift': 1 });
    expect(laneTrace([{ ...call, options: { ...call.options, priority: 'health' } }])).not.toEqual(base);
    expect(laneTrace([{ ...call, ambient: 'background' }])).not.toEqual(base);
  });
});
