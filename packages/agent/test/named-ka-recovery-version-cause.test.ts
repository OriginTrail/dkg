// SPDX-License-Identifier: Apache-2.0

/**
 * What a deferred recovery says when the chain adapter could establish no version view.
 *
 * The decision is not what these rows are about: whether recovery defers is tested where it
 * always was (named-ka-publish-recovery.test.ts, untouched). These rows pin what the deferral
 * carries: the adapter's reason appended to the message, the same reason as a field for the
 * pending log, and nothing different when the adapter says nothing.
 */

import { describe, expect, it } from 'vitest';
import type { KnowledgeAssetVersionSnapshotUnavailable } from '@origintrail-official/dkg-chain';
import { normalizeRecoveredNamedKaPublish } from '../src/named-ka-publish-recovery.js';
import {
  namedKaRecoveryDiagnostics,
  versionViewBlockingEndpoints,
  versionViewCause,
} from '../src/named-ka-recovery-diagnostics.js';
import {
  DEFERRED,
  NO_ENDPOINT_SERVES,
  NO_ENDPOINT_SERVES_WORDS,
  NO_VIEW_DEFERRAL,
  NO_VIEW_REASON,
  baseRequest,
  chainWithSnapshotRead,
  currentView,
  legacyEvidence,
  positionedEvidence,
  queuedTx,
  unavailableRead,
} from './_helpers/named-ka-recovery-fixture.js';

const DEADLINE = 'named-KA recovery deadline reached before the chain reads completed';

function recover(
  chain: ReturnType<typeof chainWithSnapshotRead>,
  extra: Partial<Parameters<typeof normalizeRecoveredNamedKaPublish>[0]> = {},
) {
  return normalizeRecoveredNamedKaPublish({
    chain,
    request: baseRequest(),
    queued: queuedTx(),
    recovery: positionedEvidence(),
    ...extra,
  });
}

describe('normalizeRecoveredNamedKaPublish — why no version view could be established', () => {
  it('appends what the adapter reported, and carries it, still as the same deferral', async () => {
    const deferral = await recover(chainWithSnapshotRead(unavailableRead(NO_ENDPOINT_SERVES)))
      .then(() => undefined, (error: unknown) => error);

    expect(deferral).toMatchObject({
      ...DEFERRED,
      message: `${NO_VIEW_DEFERRAL}: ${NO_ENDPOINT_SERVES_WORDS}`,
    });
    // The reason without the asset, and the report itself, for the pending log.
    expect(namedKaRecoveryDiagnostics(deferral)).toEqual({
      pendingReason: `${NO_VIEW_REASON}: ${NO_ENDPOINT_SERVES_WORDS}`,
      versionViewUnavailable: NO_ENDPOINT_SERVES,
    });
  });

  it('says exactly what it said before when the adapter reports nothing', async () => {
    const deferral = await recover(chainWithSnapshotRead(async () => null))
      .then(() => undefined, (error: unknown) => error);

    expect(deferral).toMatchObject({ ...DEFERRED, message: NO_VIEW_DEFERRAL });
    expect(namedKaRecoveryDiagnostics(deferral)).toEqual({ pendingReason: NO_VIEW_REASON });
  });

  it.each<[string, KnowledgeAssetVersionSnapshotUnavailable, string]>([
    [
      "the node's own request budget",
      { reason: 'local-pressure', endpointCount: 3, endpoints: [] },
      "the node's own RPC request budget was full before another endpoint could be asked",
    ],
    [
      'a storage binding that changed',
      { reason: 'storage-binding-changed', endpointCount: 3, endpoints: [] },
      'the storage contract binding changed during the read',
    ],
    [
      'an unresolved storage contract',
      { reason: 'no-storage-contract', endpointCount: 3, endpoints: [] },
      'the knowledge asset storage contract is not resolved',
    ],
  ])('names %s as the cause', async (_name, report, words) => {
    await expect(recover(chainWithSnapshotRead(unavailableRead(report)))).rejects.toMatchObject({
      ...DEFERRED,
      message: `${NO_VIEW_DEFERRAL}: ${words}`,
    });
  });

  it('never decides from the report: a view is used whatever was reported beside it', async () => {
    const chain = chainWithSnapshotRead(async (_kaId, options) => {
      options?.onUnavailable?.(NO_ENDPOINT_SERVES);
      return currentView();
    });

    const result = await recover(chain);

    expect(result.materialization.superseded).toBe(false);
  });

  it('never decides from the report: evidence without a position still settles by the latest root', async () => {
    const result = await recover(
      chainWithSnapshotRead(unavailableRead(NO_ENDPOINT_SERVES)),
      { recovery: legacyEvidence() },
    );

    expect(result.materialization).toMatchObject({ superseded: false });
  });
});

describe('normalizeRecoveredNamedKaPublish — a deadline during the version read', () => {
  const cutShort: KnowledgeAssetVersionSnapshotUnavailable = {
    reason: 'aborted',
    endpointCount: 2,
    endpoints: [
      { position: 1, host: 'rpc.example', stage: 'pinned-read', failure: 'timeout' },
      { position: 2, host: 'backup.example', stage: 'head-block', failure: 'no-answer' },
    ],
  };

  async function deadlineDuring(report: KnowledgeAssetVersionSnapshotUnavailable) {
    const controller = new AbortController();
    const chain = chainWithSnapshotRead(async (_kaId, options) => {
      controller.abort();
      options?.onUnavailable?.(report);
      return null;
    });
    return recover(chain, { signal: controller.signal }).then(() => undefined, (error: unknown) => error);
  }

  it('says where the read stood, and keeps one reason whatever it found', async () => {
    const error = await deadlineDuring(cutShort);

    expect(error).toMatchObject({
      name: 'RecoveryDeadlineReachedError',
      message: `${DEADLINE}: endpoint 1 of 2 (rpc.example) timed out on a block-pinned read; `
        + 'endpoint 2 of 2 (backup.example) had not answered the head block read when the read was cancelled',
    });
    // Which endpoint a deadline finds in flight changes from tick to tick. The reason does
    // not, so the pending log does not treat every tick as news.
    expect(namedKaRecoveryDiagnostics(error)).toEqual({
      pendingReason: DEADLINE,
      versionViewUnavailable: cutShort,
    });
    // And a deadline is not something to fix at an endpoint.
    expect(versionViewBlockingEndpoints(cutShort)).toBeUndefined();
  });

  it('says what it said before when no endpoint had been asked', async () => {
    const error = await deadlineDuring({ reason: 'aborted', endpointCount: 2, endpoints: [] });

    expect(error).toMatchObject({ name: 'RecoveryDeadlineReachedError', message: DEADLINE });
  });

  it('says what it said before when the adapter reports nothing', async () => {
    const controller = new AbortController();
    const chain = chainWithSnapshotRead(async () => { controller.abort(); return null; });

    await expect(recover(chain, { signal: controller.signal })).rejects.toMatchObject({
      name: 'RecoveryDeadlineReachedError',
      message: DEADLINE,
      pendingReason: DEADLINE,
    });
  });
});

describe('normalizeRecoveredNamedKaPublish — telling the caller a view was read', () => {
  it('tells it when the adapter supplied a view, also when recovery then defers for another reason', async () => {
    let read = 0;
    const onVersionView = () => { read += 1; };

    await recover(chainWithSnapshotRead(async () => currentView()), { onVersionView });
    expect(read).toBe(1);

    // A view behind the recovered transaction's position defers, and it is still a view.
    await expect(recover(
      chainWithSnapshotRead(async () => currentView()),
      { onVersionView, recovery: positionedEvidence('2') },
    )).rejects.toMatchObject(DEFERRED);
    expect(read).toBe(2);
  });

  it('does not tell it when there was no view', async () => {
    let read = 0;

    await expect(recover(
      chainWithSnapshotRead(unavailableRead(NO_ENDPOINT_SERVES)),
      { onVersionView: () => { read += 1; } },
    )).rejects.toMatchObject(DEFERRED);

    expect(read).toBe(0);
  });
});

describe('recovery diagnostics', () => {
  it('reads nothing from an error that carries none', () => {
    expect(namedKaRecoveryDiagnostics(new Error('store unavailable'))).toEqual({});
    expect(namedKaRecoveryDiagnostics('plain text')).toEqual({});
    expect(namedKaRecoveryDiagnostics(null)).toEqual({});
  });

  it('ignores fields that are not what they claim to be', () => {
    expect(namedKaRecoveryDiagnostics({ pendingReason: '', versionViewUnavailable: 'report' })).toEqual({});
    expect(namedKaRecoveryDiagnostics({ pendingReason: 7, versionViewUnavailable: { endpointCount: 2 } })).toEqual({});
    expect(namedKaRecoveryDiagnostics({ versionViewUnavailable: null })).toEqual({});
  });

  it('names the endpoints that hold recovery only when every one was asked and failed', () => {
    expect(versionViewBlockingEndpoints(NO_ENDPOINT_SERVES)).toBe(NO_ENDPOINT_SERVES_WORDS);
    expect(versionViewBlockingEndpoints(undefined)).toBeUndefined();
    expect(versionViewBlockingEndpoints({ ...NO_ENDPOINT_SERVES, endpoints: [] })).toBeUndefined();
    // The node's own budget stopped the read: the endpoint that had failed first is not the cause.
    expect(versionViewBlockingEndpoints({ ...NO_ENDPOINT_SERVES, reason: 'local-pressure' })).toBeUndefined();
    expect(versionViewBlockingEndpoints({ ...NO_ENDPOINT_SERVES, reason: 'aborted' })).toBeUndefined();
    // The storage binding moved on under the read: the node's own fence, not an endpoint.
    expect(versionViewBlockingEndpoints({ ...NO_ENDPOINT_SERVES, reason: 'storage-binding-changed' })).toBeUndefined();
  });

  it('adds a cause to a message only when there is a report', () => {
    expect(versionViewCause(undefined)).toBe('');
    expect(versionViewCause(NO_ENDPOINT_SERVES)).toBe(`: ${NO_ENDPOINT_SERVES_WORDS}`);
  });
});
