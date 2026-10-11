import type { GossipSession, SwmHostModeCustody } from '../src/gossip-session.js';
import type { DKGAgent } from '../src/dkg-agent.js';
import { SUBSCRIPTION_SOURCES } from '@origintrail-official/dkg-core';

declare const agent: DKGAgent;
declare const session: GossipSession;
declare const descriptor: SwmHostModeCustody;
agent.wireSwmHostModeHandler('owned', SUBSCRIPTION_SOURCES.RECONCILER, descriptor);
// @ts-expect-error Classification cannot discard the captured admission descriptor.
agent.wireSwmHostModeHandler('owned', SUBSCRIPTION_SOURCES.RECONCILER, false);
// @ts-expect-error Automatic public custody requires its pure lifetime proof.
const incomplete: SwmHostModeCustody = { kind: 'automatic-public' };
// @ts-expect-error There is no separate classification mutation after installation.
session.hostModeRegistrations.classify('owned', descriptor);
void incomplete;
