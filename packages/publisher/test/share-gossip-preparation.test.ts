/**
 * A share's gossip message prepared for the network before the write commits
 * (`ShareOptions.prepareGossip`), as the agent does to sign its envelope. The
 * preparation runs once the message is built and size-checked, before the
 * curator confirmation and before anything is stored, and returns only the
 * envelope bytes; a failure stores nothing. The publisher attaches the bytes
 * to the payload it built, whose message and fan-out provenance it keeps, and
 * that one payload goes to the confirmation and into the write result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_GOSSIP_MAX_MESSAGE_BYTES, TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher, type PrepareWorkspaceGossip } from '../src/index.js';

const CG = 'gossip-preparation-cg';
const PEER = '12D3KooWGossipPreparation';
const ENTITY = 'urn:test:gossip-preparation:entity';
const ENVELOPE = new Uint8Array([0xe1, 0xe2, 0xe3]);

function item(value: string): Quad[] {
  return [{ subject: ENTITY, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }];
}

describe('share gossip preparation', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
  });

  async function storedValues(): Promise<string[]> {
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <did:dkg:context-graph:${CG}/_shared_memory> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    return result.type === 'bindings' ? result.bindings.map((row) => String(row['o'])) : [];
  }

  it('prepares the envelope before the confirmation and the commit, and returns it with the payload it built', async () => {
    const order: string[] = [];
    const prepareGossip = vi.fn<PrepareWorkspaceGossip>(async () => {
      order.push('prepare');
      expect(await storedValues()).toEqual([]);
      return ENVELOPE;
    });
    const confirmBeforeCommit = vi.fn(async () => {
      order.push('confirm');
      expect(await storedValues()).toEqual([]);
      return { applied: true };
    });

    const result = await publisher.share(CG, item('prepared'), { publisherPeerId: PEER, prepareGossip, confirmBeforeCommit });

    expect(order).toEqual(['prepare', 'confirm']);
    expect(await storedValues()).toEqual(['"prepared"']);
    // The publisher's own message and fan-out provenance, with the prepared envelope attached.
    expect(result.gossipPayload.message).toBe(prepareGossip.mock.calls[0]![0]);
    expect(result.gossipPayload.fanout).toEqual({ kind: 'resolve-current' });
    expect(result.gossipPayload.envelope).toBe(ENVELOPE);
    expect(confirmBeforeCommit).toHaveBeenCalledWith(result.gossipPayload.message, result.gossipPayload);
  });

  it('stores nothing when the preparation fails, and never asks for a confirmation', async () => {
    const confirmBeforeCommit = vi.fn(async () => ({ applied: true }));
    await expect(publisher.share(CG, item('refused'), {
      publisherPeerId: PEER,
      prepareGossip: async () => { throw new Error('signature refused'); },
      confirmBeforeCommit,
    })).rejects.toThrow('signature refused');
    expect(confirmBeforeCommit).not.toHaveBeenCalled();
    expect(await storedValues()).toEqual([]);
  });

  it('refuses an oversized message before preparing it, and leaves an unprepared payload as it was', async () => {
    const prepareGossip = vi.fn<PrepareWorkspaceGossip>();
    const oversized: Quad[] = [];
    for (let index = 0; oversized.length * 16 * 1024 < DKG_GOSSIP_MAX_MESSAGE_BYTES + 1024 * 1024; index += 1) {
      oversized.push({ subject: `${ENTITY}:${index}`, predicate: 'http://schema.org/description', object: `"${'x'.repeat(16 * 1024)}"`, graph: '' });
    }
    await expect(publisher.share(CG, oversized, { publisherPeerId: PEER, prepareGossip })).rejects.toThrow(/too large/i);
    expect(prepareGossip).not.toHaveBeenCalled();

    const confirmBeforeCommit = vi.fn(async () => ({ applied: true }));
    const plain = await publisher.share(CG, item('plain'), { publisherPeerId: PEER, confirmBeforeCommit });
    expect('envelope' in plain.gossipPayload).toBe(false);
    expect(confirmBeforeCommit).toHaveBeenCalledWith(plain.gossipPayload.message, plain.gossipPayload);
  });
});
