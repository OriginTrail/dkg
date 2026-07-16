import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphDataGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';

// #1233 — the agents registry context graph (`SYSTEM_CONTEXT_GRAPHS.AGENTS`) never
// confirms on-chain, and its per-publish tentative `_meta` tracking record has no
// consumer (it is served from the DATA graph). The publisher detects this CG
// centrally via `isAgentRegistryContextGraph` and skips the `_meta` write at the
// local publish terminal; the data graph is still written, and every other CG
// keeps its `_meta`. (The dominant per-peer-heartbeat source — the gossip publish
// receiver — is covered in the agent's gossip-publish-handler suite.)

const ENTITY = 'did:dkg:agent:0x00000000000000000000000000000000000000a1';

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

function profileQuads(cg: string): Quad[] {
  const g = contextGraphDataGraphUri(cg);
  return [{ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Agent"', graph: g }];
}

const metaOf = (cg: string) => `did:dkg:context-graph:${cg}/_meta`;

describe('DKGPublisher agents-registry _meta skip (#1233 — agents/_meta bloat)', () => {
  it('writes a tentative _meta record for a normal data CG (chainless publish)', async () => {
    const { publisher, store } = await makePublisher();
    const cg = 'meta-keep-test';

    await publisher.publish({ contextGraphId: cg, quads: profileQuads(cg) });

    expect(
      await store.countQuads(metaOf(cg)),
      'a normal chainless publish keeps its tentative tracking record',
    ).toBeGreaterThan(0);
  });

  it('writes NO _meta record for the agents registry CG on publish (data still written)', async () => {
    const { publisher, store } = await makePublisher();
    const cg = SYSTEM_CONTEXT_GRAPHS.AGENTS;

    const result = await publisher.publish({ contextGraphId: cg, quads: profileQuads(cg) });

    expect(result.kaManifest[0]?.rootEntity).toBe(ENTITY);
    expect(
      await store.countQuads(contextGraphDataGraphUri(cg)),
      'the agents data graph still receives the profile quads',
    ).toBeGreaterThan(0);
    expect(await store.countQuads(metaOf(cg)), 'agents/_meta must not accumulate on publish').toBe(0);
  });
});
