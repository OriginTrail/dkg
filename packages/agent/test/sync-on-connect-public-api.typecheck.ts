import type { DKGAgent } from '../src/index.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import type { SyncOnConnectContext } from '../src/sync/on-connect/sync-on-connect.js';
import { ReconciledSyncOnConnectPeerJobRunner } from '../src/sync/on-connect/peer-job-runner.js';
import { PeerSyncSessionTestDriver } from './_helpers/peer-sync-session-driver.js';

// An active session must always be able to construct its scheduler.
// @ts-expect-error scheduler callbacks are mandatory for active construction
new PeerSyncSession();

type AssertFalse<Value extends false> = Value;
type AssertTrue<Value extends true> = Value;

type SyncContextRequiresLifetime = AssertTrue<
  {} extends Pick<SyncOnConnectContext, 'signal'> ? false : true
>;

type PeerJobOptions = ConstructorParameters<
  typeof ReconciledSyncOnConnectPeerJobRunner
>[1];
type PeerJobRequiresLifetime = AssertTrue<
  {} extends Pick<PeerJobOptions, 'signal'> ? false : true
>;

const activeSession = new PeerSyncSession({
  createJob: () => { throw new Error('type-only driver fixture'); },
  onInternalError: () => undefined,
});
const driver = new PeerSyncSessionTestDriver(() => activeSession);
driver.markSkipped('peer');
driver.recordQueued('peer', 1);
driver.recordFreshness('peer', { successfulAt: 2, progressAt: 3 });
driver.snapshot('peer');
activeSession.close();

type DkgAgentExposesPeerJobFactory =
  'createSyncOnConnectPeerJobRunner' extends keyof DKGAgent ? true : false;

type PeerJobFactoryStaysInternal = AssertFalse<DkgAgentExposesPeerJobFactory>;

export type { PeerJobFactoryStaysInternal };
export type { PeerJobRequiresLifetime, SyncContextRequiresLifetime };

export type ConnectionContinuationStaysInternal = AssertFalse<
  'syncAfterPeerConnection' extends keyof DKGAgent ? true : false
>;
export type PeerUpdateContinuationStaysInternal = AssertFalse<
  'retrySyncAfterPeerUpdate' extends keyof DKGAgent ? true : false
>;
