import type { GossipSession, SwmHostModeCustody } from '../src/gossip-session.js';
import { createSwmHostModeHandler } from '../src/internal/gossip/host-mode-handler.js';
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

// @ts-expect-error Every handler requires its registration-owned admission capture.
createSwmHostModeHandler(agent, { warn: () => {}, debug: () => {} }, session, 'owned');

// @ts-expect-error Concrete legacy ingestion cannot omit the captured admission fence.
agent.ingestSwmHostModeEnvelope('owned', new Uint8Array(), 'peer');
// @ts-expect-error Concrete chunk ingestion cannot omit the captured admission fence.
agent.ingestSwmCiphertextChunkEnvelope('owned', new Uint8Array(), 'peer');
agent.ingestSwmHostModeEnvelope('owned', new Uint8Array(), 'peer', () => session.active);
agent.ingestSwmCiphertextChunkEnvelope('owned', new Uint8Array(), 'peer', () => session.active);
