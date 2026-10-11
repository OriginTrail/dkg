import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { buildAuthorAttestationTypedData, MemoryLayer, contextGraphLayerUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const AUTHOR = '0xA32f1cc125401B55911678847426759094055B2d';
const OTHER = '0x2222222222222222222222222222222222222222';

describe('create with an externally reserved KA id', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it('uses the signed author slot and advances the local allocator floor', async () => {
    const allocator = makeTestKaNumberAllocator();
    agent = await DKGAgent.create({
      name: 'ReservedSlotNode',
      listenPort: 0,
      listenHost: '127.0.0.1',
      store: new OxigraphStore(),
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'core',
      skills: [],
      kaNumberAllocator: allocator,
    });
    await agent.start();

    const reservedKaId = (BigInt(AUTHOR) << 96n) | 7n;
    let capturedAuthor: string | undefined;
    let capturedAllocation: Readonly<{ number: bigint; reservedUal: string }> | undefined;
    vi.spyOn((agent as any).publisher, 'assertionCreate').mockImplementation(
      async (_contextGraphId: string, _name: string, author: string, _subGraphName: string | undefined, options: any) => {
        capturedAuthor = author;
        capturedAllocation = await options.allocateKaNumber();
        return 'urn:test:reserved-slot';
      },
    );

    await expect(agent.assertion.create('reserved-slot-cg', 'draft', {
      agentAddress: AUTHOR,
      reservedKaId,
    })).resolves.toBe('urn:test:reserved-slot');

    expect(capturedAuthor).toBe(AUTHOR);
    expect(capturedAllocation).toEqual({
      number: 7n,
      reservedUal: `did:dkg:none/${AUTHOR.toLowerCase()}/7`,
    });
    expect(allocator.peekKaId(AUTHOR)).toBe((BigInt(AUTHOR) << 96n) | 8n);
  });

  it.each(['lowercase', 'checksummed'])('keeps a lowercase signature on its %s storage lifecycle through share', async (casing) => {
    const wallet = new ethers.Wallet(`0x${'35'.repeat(32)}`);
    const author = casing === 'lowercase' ? wallet.address.toLowerCase() : wallet.address;
    const kav10Address = `0x${'11'.repeat(20)}`;
    const store = new OxigraphStore();
    agent = await DKGAgent.create({
      name: 'LowercaseReservedSlot', listenPort: 0, listenHost: '127.0.0.1', store,
      chainAdapter: Object.assign(new NoChainAdapter(), {
        chainId: 'evm:31337',
        getEvmChainId: async () => 31337n,
        getKnowledgeAssetsLifecycleAddress: async () => kav10Address,
      }),
      nodeRole: 'core', skills: [], kaNumberAllocator: makeTestKaNumberAllocator(),
    });
    await agent.start();
    const contextGraphId = 'reserved-slot-cg';
    const name = 'lowercase';
    const reservedKaId = (BigInt(author) << 96n) | 7n;
    const quads = [{ subject: 'urn:test:lowercase', predicate: 'urn:test:value', object: '"one lifecycle"', graph: '' }];
    const merkleRoot = computeFlatKCRootV10(quads, []);
    const typedData = buildAuthorAttestationTypedData({
      chainId: 31337n, kav10Address, authorAddress: author, merkleRoot, reservedKaId, schemeVersion: 1,
    });
    const signed = ethers.Signature.from(await wallet.signTypedData(typedData.domain, typedData.types, typedData.message));
    const preSignedAuthorAttestation = {
      address: author.toLowerCase(), reservedKaId,
      signature: { r: ethers.getBytes(signed.r), vs: ethers.getBytes(signed.yParityAndS) },
    };
    await agent.assertion.create(contextGraphId, name, { agentAddress: author, reservedKaId });
    await agent.assertion.write(contextGraphId, name, quads, { agentAddress: author });
    const sealed = await agent.assertion.finalize(contextGraphId, name, { agentAddress: author, preSignedAuthorAttestation });
    expect(sealed.authorAddress.toLowerCase()).toBe(author.toLowerCase());
    expect(sealed.kaUal).toBe(`did:dkg:evm:31337/${author.toLowerCase()}/7`);
    const selected = casing === 'lowercase' ? wallet.address : wallet.address.toLowerCase();
    expect((await agent.assertion.history(contextGraphId, name, { agentAddress: selected }))?.agentAddress).toBe(author);
    await expect(agent.assertion.promote(contextGraphId, name, {
      agentAddress: author, preSignedAuthorAttestation, entities: 'all',
    })).resolves.toMatchObject({ promotedCount: 1, sealed: true });
    expect(await store.countQuads(contextGraphLayerUri(contextGraphId, MemoryLayer.SharedWorkingMemory, author, 7n)))
      .toBeGreaterThan(0);
  });

  it.each([false, true])('rejects a conflicting reservation without changing an existing lifecycle (sealed: %s)', async (sealed) => {
    const wallet = new ethers.Wallet(`0x${'35'.repeat(32)}`);
    const author = wallet.address.toLowerCase();
    const store = new OxigraphStore();
    const allocator = makeTestKaNumberAllocator();
    const kav10Address = `0x${'11'.repeat(20)}`;
    agent = await DKGAgent.create({
      name: 'ExistingReservedSlot', listenPort: 0, listenHost: '127.0.0.1', store,
      chainAdapter: Object.assign(new NoChainAdapter(), {
        chainId: 'evm:31337', getEvmChainId: async () => 31337n,
        getKnowledgeAssetsLifecycleAddress: async () => kav10Address,
      }),
      nodeRole: 'core', skills: [], kaNumberAllocator: allocator,
    });
    await agent.start();
    const contextGraphId = 'existing-reserved-slot';
    const name = 'asset';
    const reservedKaId = (BigInt(author) << 96n) | 7n;
    const opts = { agentAddress: author, reservedKaId };
    const quads = [{ subject: 'urn:existing', predicate: 'urn:value', object: '"original"', graph: '' }];
    const graph = await agent.assertion.create(contextGraphId, name, opts);
    await agent.assertion.write(contextGraphId, name, quads, opts);
    if (sealed) {
      const typedData = buildAuthorAttestationTypedData({
        chainId: 31337n, kav10Address, authorAddress: author,
        merkleRoot: computeFlatKCRootV10(quads, []), reservedKaId, schemeVersion: 1,
      });
      const signed = ethers.Signature.from(await wallet.signTypedData(typedData.domain, typedData.types, typedData.message));
      await agent.assertion.finalize(contextGraphId, name, {
        agentAddress: author,
        preSignedAuthorAttestation: { address: author, reservedKaId,
          signature: { r: ethers.getBytes(signed.r), vs: ethers.getBytes(signed.yParityAndS) } },
      });
    }
    const snapshot = () => store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
    const before = await snapshot();
    const floor = allocator.peekKaId(author);
    const disposition = vi.fn();
    await expect(agent.assertion.create(contextGraphId, name, {
      ...opts, reservedKaId: reservedKaId + 1n, onDisposition: disposition,
    })).rejects.toMatchObject({ code: 'KA_RESERVED_ID_MISMATCH' });
    expect(disposition).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(allocator.peekKaId(author)).toBe(floor);
    await expect(agent.assertion.create(contextGraphId, name, opts)).resolves.toBe(graph);
    expect(await agent.assertion.query(contextGraphId, name, { agentAddress: author })).toEqual(expect.arrayContaining(quads.map(q => expect.objectContaining({ subject: q.subject, object: q.object }))));
    if (sealed) expect(await snapshot()).toEqual(before);
  });

  it('rejects a reserved id from another author namespace before creating', async () => {
    agent = await DKGAgent.create({
      name: 'ReservedSlotNamespaceNode',
      listenPort: 0,
      listenHost: '127.0.0.1',
      store: new OxigraphStore(),
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'core',
      skills: [],
      kaNumberAllocator: makeTestKaNumberAllocator(),
    });
    await agent.start();
    const assertionCreate = vi.spyOn((agent as any).publisher, 'assertionCreate');

    await expect(agent.assertion.create('reserved-slot-cg', 'draft', {
      agentAddress: AUTHOR,
      reservedKaId: (BigInt(OTHER) << 96n) | 7n,
    })).rejects.toThrow('outside author');
    expect(assertionCreate).not.toHaveBeenCalled();
  });
});
