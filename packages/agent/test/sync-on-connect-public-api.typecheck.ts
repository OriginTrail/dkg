import type { DKGAgent } from '../src/index.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';

// An active session must always be able to construct its scheduler.
// @ts-expect-error scheduler callbacks are mandatory for active construction
new PeerSyncSession();

type AssertFalse<Value extends false> = Value;

type DkgAgentExposesPeerJobFactory =
  'createSyncOnConnectPeerJobRunner' extends keyof DKGAgent ? true : false;

type PeerJobFactoryStaysInternal = AssertFalse<DkgAgentExposesPeerJobFactory>;

export type { PeerJobFactoryStaysInternal };

export type ConnectionContinuationStaysInternal = AssertFalse<
  'syncAfterPeerConnection' extends keyof DKGAgent ? true : false
>;
export type PeerUpdateContinuationStaysInternal = AssertFalse<
  'retrySyncAfterPeerUpdate' extends keyof DKGAgent ? true : false
>;
