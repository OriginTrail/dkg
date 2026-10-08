// SPDX-License-Identifier: Apache-2.0

// The agent gate while real shares run into the same context graph (GH#3069):
// real store, production store wrapper, real projection and real publisher.
// Only chain authority is stubbed, and its read is where the other shares land.
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { ethers } from 'ethers';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';

import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  resolveContextGraphAgentGateAuthorityDecision,
} from '../src/internal/context-graph-authority/context-graph-agent-gate-authority.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { createPromotionAgentForTest } from './_helpers/promotion-agent.js';

const CG = 'agent-gate-during-share-cg';
const PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const signer = new ethers.Wallet(`0x${'5'.repeat(64)}`);
const MEMBER = signer.address;

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

/** A node that has `assets` ready to share into a graph whose roster allows its own agent. */
async function open(assets: number) {
  const inner = new OxigraphStore();
  stores.push(inner);
  const projection = new ContextGraphMetaProjection(inner);
  const store: TripleStore = createListContextGraphsCacheInvalidatingStore(
    inner,
    () => {},
    createProjectionMutationObserver(() => projection),
  );
  const { agent, publisher } = await createPromotionAgentForTest(store as never, { agentAddress: MEMBER, peerId: PEER });
  await store.insert([{
    subject: contextGraphDataGraphUri(CG),
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    object: `"${MEMBER}"`,
    graph: contextGraphMetaGraphUri(CG),
  }]);
  const ready: string[] = [];
  for (let n = 0; n < assets; n += 1) {
    const name = `asset-${n}`;
    await publisher.assertionCreate(CG, name, MEMBER);
    await publisher.assertionWrite(CG, name, MEMBER, [
      { subject: `urn:test:entity:${name}`, predicate: 'http://schema.org/name', object: `"${name}"` },
    ]);
    await finalizeRootlessAssertionForTest({ publisher, store: store as never, contextGraphId: CG, name, agentAddress: MEMBER });
    ready.push(name);
  }
  /** One real share: working memory to shared memory, with every metadata write it makes. */
  const share = async (): Promise<void> => {
    const name = ready.shift();
    if (name === undefined) throw new Error('no asset left to share');
    await expect(agent.assertion.promote(CG, name, { accessPolicy: 'public', agentAddress: MEMBER }))
      .resolves.toMatchObject({ promotedCount: 1 });
  };

  agent.contextGraphMetaProjection = projection;
  agent.subscribedContextGraphs = new Map();
  agent.localAgents = new Map([[MEMBER.toLowerCase(), { agentAddress: MEMBER, privateKey: signer.privateKey }]]);
  // Every chain read of the gate takes as long as another share into the same graph.
  agent.resolveSwmTransportAuthority = vi.fn(async () => {
    await share();
    return { kind: 'plaintext' };
  });
  const rosterReads = vi.spyOn(agent, 'getCgMeta');
  return { agent, projection, share, rosterReads };
}

describe('agent gate while shares run into the same context graph (GH#3069)', () => {
  it('a share moves the node-wide revision and leaves the roster revision of its graph alone', async () => {
    const { projection, share } = await open(3);
    const rosterRevision = projection.peerGateRevision.read(CG);
    const nodeWideRevision = projection.readAuthorityFactsRevision;

    await share();
    await Promise.all([share(), share()]);

    expect(projection.peerGateRevision.read(CG)).toBe(rosterRevision);
    expect(projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWideRevision + 3);
  });

  it('finds the signer from one roster read while another share completes during each of its reads', async () => {
    // Ten shares are used; the rest are there so that a gate that reads three times fails on its answer.
    const { agent, projection, rosterReads } = await open(18);

    // The same reads compared on the node-wide revision: every one of the three sees it move.
    await expect(resolveContextGraphAgentGateAuthorityDecision({
      contextGraphId: CG,
      getTransportAuthority: () => agent.resolveSwmTransportAuthority(CG),
      readRosterRevision: () => projection.readAuthorityFactsRevision,
      getLegacyMeta: () => projection.get(CG),
      getSubscriptionAgents: () => [],
    })).resolves.toMatchObject({ kind: 'unavailable', reason: 'local-existence-unavailable' });
    expect(agent.resolveSwmTransportAuthority).toHaveBeenCalledTimes(6);

    await expect(agent.getContextGraphAgentGateAddresses(CG)).resolves.toEqual([MEMBER]);
    // The helper stubs the signer for the shares it runs; this is the real one.
    await expect(DKGAgent.prototype.resolveWorkspaceGossipSigningAgent.call(agent, CG))
      .resolves.toMatchObject({ agentAddress: MEMBER, privateKey: signer.privateKey });

    expect(rosterReads).toHaveBeenCalledTimes(2);
    expect(agent.resolveSwmTransportAuthority).toHaveBeenCalledTimes(10);
  });
});
