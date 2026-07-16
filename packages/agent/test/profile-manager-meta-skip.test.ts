import { describe, expect, it } from 'vitest';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  generateEd25519Keypair,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import { ProfileManager } from '../src/profile-manager.js';

// #1233 — integration guard for the production agent-profile publish. The
// publisher detects the agents registry CG centrally (isAgentRegistryContextGraph),
// so ProfileManager has no flag to set or miswire; this pins the integration: a
// profile publish through ProfileManager populates the agents DATA graph but
// writes NO tentative `_meta`. (The update()/restatement heartbeat path is
// covered directly in the publisher suite — under NoChainAdapter, publish()
// returns kaId 0n, so ProfileManager never transitions to update() in-test.)

const AGENTS = SYSTEM_CONTEXT_GRAPHS.AGENTS;
const META_GRAPH = `did:dkg:context-graph:${AGENTS}/_meta`;

describe('ProfileManager.publishProfile keeps agents/_meta empty (#1233)', () => {
  it('populates the agents data graph but writes no tentative _meta record', async () => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const profileManager = new ProfileManager(publisher, store);

    await profileManager.publishProfile({
      peerId: '12D3KooWMetaBloatGuard',
      name: 'Heartbeat Agent',
      skills: [],
      agentAddress: '0x00000000000000000000000000000000000000a1',
    });

    expect(
      await store.countQuads(contextGraphDataGraphUri(AGENTS)),
      'the profile must still be published to the agents data graph',
    ).toBeGreaterThan(0);
    expect(
      await store.countQuads(META_GRAPH),
      'ProfileManager must not write any agents/_meta tracking record',
    ).toBe(0);
  });
});
