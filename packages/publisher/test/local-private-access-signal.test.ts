import { describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  TypedEventBus,
  contextGraphDataUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';

/**
 * Whether a graph looks private locally, which is what lets a publish before
 * registration keep its generated private catalog floor. A gate counts when the
 * graph's own metadata states it.
 */

const CG_ID = 'local-private-access-signal';
const META_GRAPH = contextGraphMetaUri(CG_ID);
const AGENTS_GRAPH = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const ONTOLOGY_GRAPH = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';

const row = (predicate: string, value: string, graph: string): Quad => (
  { subject: contextGraphDataUri(CG_ID), predicate, object: `"${value}"`, graph }
);

async function signalWith(rows: Quad[]): Promise<boolean> {
  const store = new OxigraphStore();
  await store.insert(rows);
  const publisher = new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return (publisher as unknown as {
    localContextGraphHasPrivateAccessSignal(contextGraphId: string): Promise<boolean>;
  }).localContextGraphHasPrivateAccessSignal(CG_ID);
}

describe('the local private access signal of a context graph', () => {
  it.each([
    ['an allowed agent', DKG_ONTOLOGY.DKG_ALLOWED_AGENT, AGENT],
    ['a participant agent', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, AGENT],
    ['an allowed peer', DKG_ONTOLOGY.DKG_ALLOWED_PEER, '12D3KooWSignalPeer'],
  ])('is %s in its own metadata', async (_label, predicate, value) => {
    await expect(signalWith([row(predicate, value, META_GRAPH)])).resolves.toBe(true);
  });

  it.each([
    ['agents', AGENTS_GRAPH],
    ['ontology', ONTOLOGY_GRAPH],
  ])('is no gate in the %s graph', async (_label, graph) => {
    await expect(signalWith([
      row(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, AGENT, graph),
      row(DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, AGENT, graph),
      row(DKG_ONTOLOGY.DKG_ALLOWED_PEER, '12D3KooWSignalPeer', graph),
    ])).resolves.toBe(false);
  });

  it.each([
    ['its own metadata', META_GRAPH],
    ['the agents graph', AGENTS_GRAPH],
    ['the ontology graph', ONTOLOGY_GRAPH],
  ])('is a private policy in %s', async (_label, graph) => {
    await expect(signalWith([row(DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'private', graph)])).resolves.toBe(true);
  });

  it('is nothing once a graph says it is public, whatever gates it', async () => {
    await expect(signalWith([
      row(DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'public', AGENTS_GRAPH),
      row(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, AGENT, META_GRAPH),
    ])).resolves.toBe(false);
  });
});
