import type { DKGAgent } from '../src/index.js';

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
