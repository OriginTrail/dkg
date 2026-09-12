import type { DKGAgent } from '../src/index.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import type { SessionSyncOnConnectContext } from '../src/sync/on-connect/sync-on-connect.js';
import { ReconciledSyncOnConnectPeerJobRunner } from '../src/sync/on-connect/peer-job-runner.js';
import { PeerSyncSessionTestDriver } from './_helpers/peer-sync-session-driver.js';
import {
  runSyncOnConnect,
  runSelectedSharedMemoryRetry,
  type SyncOnConnectContext as PublicSyncOnConnectContext,
} from '@origintrail-official/dkg-agent/dist/sync/on-connect/sync-on-connect.js';

declare const legacyContext: Omit<PublicSyncOnConnectContext, 'signal' | 'syncingPeers'> & { syncingPeers: Set<string> };
const publicContext: PublicSyncOnConnectContext = legacyContext;
void runSyncOnConnect(publicContext);
declare const legacySelectedContext: Omit<Parameters<typeof runSelectedSharedMemoryRetry>[0], 'signal' | 'syncingPeers'> & { syncingPeers: Set<string> };
void runSelectedSharedMemoryRetry(legacySelectedContext);

// An active session must always be able to construct its scheduler.
// @ts-expect-error scheduler callbacks are mandatory for active construction
new PeerSyncSession();

type AssertFalse<Value extends false> = Value;
type AssertTrue<Value extends true> = Value;

type SyncContextRequiresLifetime = AssertTrue<
  {} extends Pick<SessionSyncOnConnectContext, 'signal'> ? false : true
>;
type SessionRequiresLeaseOwner = AssertFalse<
  Set<string> extends SessionSyncOnConnectContext['syncingPeers'] ? true : false
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
export type { PeerJobRequiresLifetime, SyncContextRequiresLifetime, SessionRequiresLeaseOwner };

export type ConnectionContinuationStaysInternal = AssertFalse<
  'syncAfterPeerConnection' extends keyof DKGAgent ? true : false
>;
export type PeerUpdateContinuationStaysInternal = AssertFalse<
  'retrySyncAfterPeerUpdate' extends keyof DKGAgent ? true : false
>;
