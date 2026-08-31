import type { DKGAgent } from '../src/index.js';

type AssertFalse<Value extends false> = Value;

type DkgAgentExposesPeerJobFactory =
  'createSyncOnConnectPeerJobRunner' extends keyof DKGAgent ? true : false;

type PeerJobFactoryStaysInternal = AssertFalse<DkgAgentExposesPeerJobFactory>;

export type { PeerJobFactoryStaysInternal };
