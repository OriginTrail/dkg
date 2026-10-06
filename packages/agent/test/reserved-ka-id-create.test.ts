import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
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
