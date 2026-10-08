// SPDX-License-Identifier: Apache-2.0

/**
 * The `Named KA recovery ... remains pending` warning, rate-limited.
 *
 * Recovery of a confirmed publish is asked again on every tick while its cause lasts. These rows
 * pin what the log shows for that: one line per asset when a reason appears or changes, a
 * summary per reason every five minutes, and one line for the operator once a chain endpoint
 * has been the named cause for a sustained run.
 */

import { describe, expect, it } from 'vitest';
import type { KnowledgeAssetVersionSnapshotUnavailable } from '@origintrail-official/dkg-chain';
import {
  NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS,
  NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_MIN_DEFERRALS,
  NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS,
  NamedKaRecoveryPendingLog,
  versionViewNamedEndpoints,
} from '../src/named-ka-recovery-pending-log.js';

const MINUTE = 60_000;
const TICK = 10_000;

const REFUSING: KnowledgeAssetVersionSnapshotUnavailable = {
  reason: 'endpoints-failed',
  endpointCount: 5,
  endpoints: [{
    position: 3,
    host: 'rpc.example',
    stage: 'pinned-read',
    failure: 'http-client-error',
    httpStatus: 400,
  }],
};
const REFUSING_WORDS = 'endpoint 3 of 5 (rpc.example) refused a block-pinned read (http 400)';
const NO_VIEW = 'the current KA version could not be established from a single coherent chain view';

function asset(name: string) {
  return { contextGraphId: 'cg-1', name };
}

/** The deferral the recovery throws for `name` when the version view is unavailable. */
function versionViewDeferral(name: string, report?: KnowledgeAssetVersionSnapshotUnavailable): Error {
  const cause = report ? `: ${versionViewNamedEndpoints(report) ?? 'no endpoint is named'}` : '';
  return Object.assign(
    new Error(`Named KA recovery rejected for "${name}": ${NO_VIEW}${cause}`),
    { code: 'KA_VM_RECOVERY_INCONSISTENT', versionViewUnavailable: report },
  );
}

function harness(options: ConstructorParameters<typeof NamedKaRecoveryPendingLog>[0] = {}) {
  const clock = { now: 1_000_000 };
  const lines: string[] = [];
  const log = new NamedKaRecoveryPendingLog({ now: () => clock.now, ...options });
  const defer = (name: string, error: unknown) => {
    const before = lines.length;
    log.deferred(asset(name), error, (line) => lines.push(line));
    return lines.slice(before);
  };
  /** One deferral per asset every tick for `ms`, starting one tick from now. Returns the new lines. */
  const run = (names: string[], ms: number, error: (name: string) => unknown) => {
    const before = lines.length;
    for (let elapsed = TICK; elapsed <= ms; elapsed += TICK) {
      clock.now += TICK;
      for (const name of names) defer(name, error(name));
    }
    return lines.slice(before);
  };
  return { clock, lines, log, defer, run };
}

describe('NamedKaRecoveryPendingLog', () => {
  it('logs the asset once, in the same words as before, and stays quiet while nothing changes', () => {
    const { defer, run } = harness();
    const error = versionViewDeferral('ka-1', REFUSING);

    expect(defer('ka-1', error)).toEqual([
      `Named KA recovery for "ka-1" remains pending: Named KA recovery rejected for "ka-1": ${NO_VIEW}: ${REFUSING_WORDS}`,
    ]);
    // Four minutes of ticks: 24 more deferrals, no more lines.
    expect(run(['ka-1'], 4 * MINUTE, () => error)).toEqual([]);
  });

  it('logs again when the reason changes, and again when it changes back', () => {
    const { defer } = harness();
    const first = new Error('store unavailable');
    const second = new Error('context graph has no local on-chain id binding');

    expect(defer('ka-1', first)).toHaveLength(1);
    expect(defer('ka-1', first)).toEqual([]);
    expect(defer('ka-1', second)).toEqual([
      'Named KA recovery for "ka-1" remains pending: context graph has no local on-chain id binding',
    ]);
    expect(defer('ka-1', first)).toEqual(['Named KA recovery for "ka-1" remains pending: store unavailable']);
  });

  it('accepts a deferral that is not an Error', () => {
    const { defer } = harness();

    expect(defer('ka-1', 'plain text')).toEqual(['Named KA recovery for "ka-1" remains pending: plain text']);
  });

  it('thirteen assets held by one endpoint: thirteen lines, one operator line at five minutes, then summaries', () => {
    const { defer, run, lines } = harness();
    const names = Array.from({ length: 13 }, (_, index) => `ka-${index + 1}`);
    const deferral = (name: string) => versionViewDeferral(name, REFUSING);

    for (const name of names) defer(name, deferral(name));
    expect(lines).toHaveLength(13);
    expect(lines.every((line) => line.endsWith(REFUSING_WORDS))).toBe(true);

    // Up to the last tick before five minutes: 29 ticks x 13 assets, nothing logged.
    expect(run(names, NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS - TICK, deferral)).toEqual([]);

    // The tick that completes five minutes: the operator is told once, by the first asset to defer.
    expect(run(names, TICK, deferral)).toEqual([
      'Operator action needed: publishes confirmed on chain are not finalizing on this node '
      + `(13 pending, 5 min) because ${REFUSING_WORDS}. `
      + 'The current-version read needs a complete answer from every configured chain endpoint at one '
      + 'pinned block. Fix the named endpoint, or replace or remove it in the chain RPC configuration '
      + '(rpcUrl / rpcUrls) and restart the node; the pending publishes then finalize without being sent again.',
    ]);

    // Five more minutes: one summary, no second operator line.
    expect(run(names, NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS, deferral)).toEqual([
      `Named KA recovery remains pending for 13 asset(s) after 10 min (781 deferrals): ${NO_VIEW}: ${REFUSING_WORDS}`,
    ]);
    // And the next five, the same way.
    expect(run(names, NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS, deferral)).toEqual([
      `Named KA recovery remains pending for 13 asset(s) after 15 min (1171 deferrals): ${NO_VIEW}: ${REFUSING_WORDS}`,
    ]);
  });

  it('does not tell the operator to act on five minutes of sparse samples', () => {
    // One deferral a minute: five minutes pass with too few of them to call it sustained.
    const { clock, defer } = harness();
    const error = versionViewDeferral('ka-1', REFUSING);
    const seen: string[] = [];

    defer('ka-1', error);
    for (let minute = 1; minute < NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_MIN_DEFERRALS; minute += 1) {
      clock.now += MINUTE;
      seen.push(...defer('ka-1', error));
    }

    // Summaries at five and ten minutes, the operator line only with the twelfth deferral.
    expect(seen.map((line) => line.slice(0, 22))).toEqual([
      'Named KA recovery rema',
      'Named KA recovery rema',
      'Operator action needed',
    ]);
    expect(seen[2]).toContain('(1 pending, 11 min)');
  });

  it('two samples either side of a long gap are two runs, not one long one', () => {
    const { clock, defer } = harness();
    const error = versionViewDeferral('ka-1', REFUSING);

    defer('ka-1', error);
    clock.now += 60 * MINUTE;

    // The asset is reported afresh, and nothing is escalated or summarized on one sample.
    expect(defer('ka-1', error)).toEqual([
      `Named KA recovery for "ka-1" remains pending: Named KA recovery rejected for "ka-1": ${NO_VIEW}: ${REFUSING_WORDS}`,
    ]);
  });

  it('tells the operator of a node whose only endpoint refuses the pinned read', () => {
    // Nothing else answered, and that is the whole configuration: the remedy is still theirs.
    const only: KnowledgeAssetVersionSnapshotUnavailable = {
      reason: 'endpoints-failed',
      endpointCount: 1,
      endpoints: [{ position: 1, host: 'only.example', stage: 'pinned-read', failure: 'http-client-error', httpStatus: 400 }],
    };
    const { defer, run } = harness();
    const deferral = (name: string) => versionViewDeferral(name, only);

    defer('ka-1', deferral('ka-1'));
    const later = run(['ka-1'], NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS, deferral);

    expect(later).toHaveLength(1);
    expect(later[0]).toContain(
      '(1 pending, 5 min) because endpoint 1 of 1 (only.example) refused a block-pinned read (http 400). ',
    );
  });

  it.each([
    ['a cancelled read found every endpoint still in flight', {
      reason: 'aborted',
      endpointCount: 2,
      endpoints: [
        { position: 1, host: 'a.example', stage: 'head-block', failure: 'no-answer' },
        { position: 2, host: 'b.example', stage: 'head-block', failure: 'no-answer' },
      ],
    } satisfies KnowledgeAssetVersionSnapshotUnavailable],
    ['no endpoint is named', { reason: 'endpoints-disagree', endpointCount: 3, endpoints: [] } satisfies
      KnowledgeAssetVersionSnapshotUnavailable],
    ['the adapter gave no report', undefined],
  ])('summarizes but never asks the operator to act on an endpoint when %s', (_name, report) => {
    const { defer, run } = harness();
    const deferral = (name: string) => versionViewDeferral(name, report);

    defer('ka-1', deferral('ka-1'));
    const later = run(['ka-1'], 20 * MINUTE, deferral);

    expect(later).toHaveLength(4);
    expect(later.every((line) => line.startsWith('Named KA recovery remains pending for 1 asset(s) after '))).toBe(true);
  });

  it('a finalized recovery ends the run: the endpoint answered, so the count starts over', () => {
    const { clock, defer, run, log } = harness();
    const deferral = (name: string) => versionViewDeferral(name, REFUSING);

    defer('ka-1', deferral('ka-1'));
    expect(run(['ka-1'], 4 * MINUTE, deferral)).toEqual([]);
    log.finalized(asset('ka-2'));

    // The run that began four minutes ago would have reached five in this stretch. It ended
    // with the finalization, and the one that follows is not yet five minutes old.
    expect(run(['ka-1'], NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS - TICK, deferral)).toEqual([]);
    const later = run(['ka-1'], 2 * TICK, deferral);
    expect(later).toHaveLength(1);
    expect(later[0]).toContain('Operator action needed');
    expect(later[0]).toContain('(1 pending, 5 min)');
    expect(clock.now).toBe(1_000_000 + 9 * MINUTE + TICK);
  });

  it('an asset that finalized and is deferred again is reported again', () => {
    const { defer, log } = harness();
    const error = versionViewDeferral('ka-1', REFUSING);

    expect(defer('ka-1', error)).toHaveLength(1);
    log.finalized(asset('ka-1'));

    expect(defer('ka-1', error)).toHaveLength(1);
  });

  it('counts only assets still being deferred, and tells same-named assets of two graphs apart', () => {
    const { clock, lines, log, run } = harness();
    const reason = new Error('store unavailable');
    const emit = (line: string) => lines.push(line);

    log.deferred({ contextGraphId: 'cg-1', name: 'ka-1' }, reason, emit);
    log.deferred({ contextGraphId: 'cg-2', name: 'ka-1' }, reason, emit);
    log.deferred({ contextGraphId: 'cg-1', name: 'ka-1', subGraphName: 'sub' }, reason, emit);
    expect(lines).toHaveLength(3);

    // Only one of the three keeps deferring. Past five minutes the others no longer count.
    const later = run(['ka-1'], NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS + TICK, () => reason);
    expect(later).toEqual([
      'Named KA recovery remains pending for 3 asset(s) after 5 min (33 deferrals): store unavailable',
    ]);
    expect(clock.now).toBe(1_000_000 + 5 * MINUTE + TICK);
    expect(run(['ka-1'], NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS, () => reason)).toEqual([
      'Named KA recovery remains pending for 1 asset(s) after 10 min (63 deferrals): store unavailable',
    ]);
  });

  it('summarizes each reason on its own, with its own assets', () => {
    const { run, lines } = harness();
    const reasons: Record<string, Error> = {
      'ka-1': new Error('store unavailable'),
      'ka-2': new Error('store unavailable'),
      'ka-3': new Error('context graph has no local on-chain id binding'),
    };

    const later = run(Object.keys(reasons), NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS + TICK, (name) => reasons[name]);

    // Three first lines, then one summary per reason once each is five minutes old.
    expect(lines.slice(0, 3).every((line) => line.startsWith('Named KA recovery for "ka-'))).toBe(true);
    expect(later.slice(3)).toEqual([
      'Named KA recovery remains pending for 2 asset(s) after 5 min (61 deferrals): store unavailable',
      'Named KA recovery remains pending for 1 asset(s) after 5 min (31 deferrals): '
      + 'context graph has no local on-chain id binding',
    ]);
  });

  it('still logs the plain line when its own bookkeeping fails', () => {
    const lines: string[] = [];
    const log = new NamedKaRecoveryPendingLog({ now: () => { throw new Error('clock'); } });

    log.deferred(asset('ka-1'), new Error('store unavailable'), (line) => lines.push(line));
    log.deferred(asset('ka-1'), new Error('store unavailable'), (line) => lines.push(line));

    // Unlimited, as it was before: losing the limit must not lose the warning.
    expect(lines).toEqual([
      'Named KA recovery for "ka-1" remains pending: store unavailable',
      'Named KA recovery for "ka-1" remains pending: store unavailable',
    ]);
  });

  it('finalizing with nothing pending, or with an asset it cannot key, does nothing and does not throw', () => {
    const { defer, log } = harness();

    expect(() => log.finalized(asset('ka-1'))).not.toThrow();
    defer('ka-1', new Error('store unavailable'));
    const unkeyable = { contextGraphId: 'cg-1', get name(): string { throw new Error('no name'); } };

    expect(() => log.finalized(unkeyable)).not.toThrow();
    // The pending asset is untouched by the failed call.
    expect(defer('ka-1', new Error('store unavailable'))).toEqual([]);
  });

  it('forgets the oldest asset past its ceiling rather than growing', () => {
    const { defer } = harness();
    const error = new Error('store unavailable');

    for (let index = 0; index <= 4_096; index += 1) defer(`ka-${index}`, error);

    // ka-0 was dropped to make room, so it reads as new; ka-4096 is still known.
    expect(defer('ka-4096', error)).toEqual([]);
    expect(defer('ka-0', error)).toHaveLength(1);
  });

  it('uses the documented bounds by default', () => {
    expect(NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS).toBe(5 * MINUTE);
    expect(NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS).toBe(5 * MINUTE);
    expect(NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_MIN_DEFERRALS).toBe(12);
    const lines: string[] = [];
    // The default clock is the wall clock.
    new NamedKaRecoveryPendingLog().deferred(asset('ka-1'), new Error('x'), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
  });
});

describe('versionViewNamedEndpoints', () => {
  it('names the endpoints that failed, whether or not another answered', () => {
    expect(versionViewNamedEndpoints(REFUSING)).toBe(REFUSING_WORDS);
    expect(versionViewNamedEndpoints({ ...REFUSING, endpointCount: 1 })).toBe(
      'endpoint 3 of 1 (rpc.example) refused a block-pinned read (http 400)',
    );
    expect(versionViewNamedEndpoints(undefined)).toBeUndefined();
    expect(versionViewNamedEndpoints({ ...REFUSING, endpoints: [] })).toBeUndefined();
    // An error object is untyped: a report that is not one names nothing.
    expect(versionViewNamedEndpoints({ endpointCount: 5 } as never)).toBeUndefined();
  });

  it('names an endpoint a cancelled read was waiting on only while another had answered', () => {
    const waiting = { ...REFUSING, reason: 'aborted' } as const;

    expect(versionViewNamedEndpoints(waiting)).toBe(REFUSING_WORDS);
    expect(versionViewNamedEndpoints({ ...waiting, endpointCount: 1 })).toBeUndefined();
  });
});
