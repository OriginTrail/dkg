import { describe, it, expect } from 'vitest';
import {
  MemoryLayer,
  TrustLevel,
  TransitionType,
  isValidTransition,
  VALID_TRANSITIONS,
  PUBLICATION_STATES,
  GET_VIEWS,
  type PublicationState,
  type GetView,
  type Publication,
  type PublicationRequest,
  type MemoryTransition,
  type DraftDescriptor,
  type ShareRecord,
} from '../src/memory-model.js';

describe('MemoryLayer enum', () => {
  it('has exactly three layers', () => {
    const values = Object.values(MemoryLayer);
    expect(values).toHaveLength(3);
  });

  it('abbreviations match spec', () => {
    expect(MemoryLayer.WorkingMemory).toBe('WM');
    expect(MemoryLayer.SharedWorkingMemory).toBe('SWM');
    expect(MemoryLayer.VerifiedMemory).toBe('VM');
  });
});

describe('TrustLevel enum', () => {
  it('has four levels ordered by ascending trust', () => {
    expect(TrustLevel.SelfAttested).toBe(0);
    expect(TrustLevel.Endorsed).toBe(1);
    expect(TrustLevel.PartiallyVerified).toBe(2);
    expect(TrustLevel.ConsensusVerified).toBe(3);
  });
});

describe('TransitionType enum', () => {
  it('has exactly CREATE and UPDATE (no MUTATE)', () => {
    const values = Object.values(TransitionType);
    expect(values).toEqual(['CREATE', 'UPDATE']);
  });
});

describe('isValidTransition', () => {
  it('WM → SWM is valid', () => {
    expect(isValidTransition(MemoryLayer.WorkingMemory, MemoryLayer.SharedWorkingMemory)).toBe(true);
  });

  it('SWM → VM is valid', () => {
    expect(isValidTransition(MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiedMemory)).toBe(true);
  });

  it('WM → VM is invalid (skip not allowed)', () => {
    expect(isValidTransition(MemoryLayer.WorkingMemory, MemoryLayer.VerifiedMemory)).toBe(false);
  });

  it('VM → WM is invalid (no backward transitions)', () => {
    expect(isValidTransition(MemoryLayer.VerifiedMemory, MemoryLayer.WorkingMemory)).toBe(false);
  });

  it('SWM → WM is invalid (no backward transitions)', () => {
    expect(isValidTransition(MemoryLayer.SharedWorkingMemory, MemoryLayer.WorkingMemory)).toBe(false);
  });

  it('self-transitions are invalid', () => {
    for (const layer of Object.values(MemoryLayer) as MemoryLayer[]) {
      expect(isValidTransition(layer, layer)).toBe(false);
    }
  });
});

describe('VALID_TRANSITIONS map', () => {
  it('has entries for 2 source layers (VM has no outgoing)', () => {
    expect(VALID_TRANSITIONS.size).toBe(2);
    expect(VALID_TRANSITIONS.has(MemoryLayer.VerifiedMemory)).toBe(false);
  });
});

describe('PublicationState type', () => {
  it('PUBLICATION_STATES contains all 7 valid states', () => {
    expect(PUBLICATION_STATES).toHaveLength(7);
    const expected: PublicationState[] = [
      'accepted', 'claimed', 'validated', 'broadcast', 'included', 'finalized', 'failed',
    ];
    expect([...PUBLICATION_STATES]).toEqual(expected);
  });
});

describe('GetView type', () => {
  it('GET_VIEWS contains all 3 views in trust order', () => {
    expect(GET_VIEWS).toHaveLength(3);
    const expected: GetView[] = [
      'working-memory', 'shared-working-memory', 'verified-memory',
    ];
    expect([...GET_VIEWS]).toEqual(expected);
  });
});

describe('Publication interface', () => {
  it('can be constructed with minimal fields', () => {
    const pub: Publication = {
      publicationId: 'pub-1',
      request: {
        contextGraphId: 'cg-42',
        transitionType: TransitionType.CREATE,
        authority: { type: 'owner', proofRef: 'sig:0x...' },
      },
      status: 'accepted',
      createdAt: '2026-04-02T00:00:00Z',
      updatedAt: '2026-04-02T00:00:00Z',
    };
    expect(pub.publicationId).toBe('pub-1');
    expect(pub.status).toBe('accepted');
    expect(pub.claim).toBeUndefined();
    expect(pub.failure).toBeUndefined();
  });

  it('can be constructed with all optional fields', () => {
    const pub: Publication = {
      publicationId: 'pub-2',
      request: {
        contextGraphId: 'cg-42',
        transitionType: TransitionType.UPDATE,
        authority: { type: 'quorum', proofRef: 'multisig:0x...' },
        swmOperationId: 'op-1',
        priorVersion: 'v1',
        convictionAccountId: 3,
        namespace: 'game',
      },
      status: 'finalized',
      createdAt: '2026-04-02T00:00:00Z',
      updatedAt: '2026-04-02T01:00:00Z',
      claim: { walletId: '0xAbc', claimedAt: '2026-04-02T00:01:00Z' },
      validation: { tripleCount: 42, merkleRoot: '0xbeef', validatedAt: '2026-04-02T00:02:00Z' },
      broadcast: { txHash: '0xfeed', broadcastAt: '2026-04-02T00:03:00Z' },
      inclusion: { blockNumber: 12345, blockTimestamp: '2026-04-02T00:04:00Z', includedAt: '2026-04-02T00:04:01Z' },
      finalization: { ual: 'did:dkg:mock:31337/0xAbc/1', batchId: '1', finalizedAt: '2026-04-02T00:05:00Z' },
    };
    expect(pub.claim!.walletId).toBe('0xAbc');
    expect(pub.finalization!.ual).toContain('did:dkg');
  });

  it('can represent a failed publication', () => {
    const pub: Publication = {
      publicationId: 'pub-3',
      request: {
        contextGraphId: 'cg-42',
        transitionType: TransitionType.CREATE,
        authority: { type: 'owner', proofRef: 'sig:0x...' },
      },
      status: 'failed',
      createdAt: '2026-04-02T00:00:00Z',
      updatedAt: '2026-04-02T00:03:00Z',
      failure: {
        failedFromState: 'broadcast',
        phase: 'confirmation',
        code: 'TX_REVERTED',
        message: 'Out of gas',
        retryable: true,
        failedAt: '2026-04-02T00:03:00Z',
      },
    };
    expect(pub.failure!.retryable).toBe(true);
    expect(pub.failure!.phase).toBe('confirmation');
  });
});

describe('PublicationRequest interface', () => {
  it('supports triples-based request', () => {
    const req: PublicationRequest = {
      contextGraphId: 'cg-1',
      triples: [
        { subject: 'http://example.org/e', predicate: 'http://schema.org/name', object: '"Alice"' },
      ],
      transitionType: TransitionType.CREATE,
      authority: { type: 'owner', proofRef: 'sig:0x...' },
    };
    expect(req.triples).toHaveLength(1);
    expect(req.constructQuery).toBeUndefined();
  });

  it('supports CONSTRUCT query-based request', () => {
    const req: PublicationRequest = {
      contextGraphId: 'cg-1',
      constructQuery: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      transitionType: TransitionType.UPDATE,
      authority: { type: 'multisig', proofRef: 'multi:0x...' },
    };
    expect(req.constructQuery).toBeTruthy();
    expect(req.triples).toBeUndefined();
  });
});

describe('MemoryTransition interface', () => {
  it('can describe a WM→SWM share', () => {
    const t: MemoryTransition = {
      from: MemoryLayer.WorkingMemory,
      to: MemoryLayer.SharedWorkingMemory,
      type: TransitionType.CREATE,
      contextGraphId: 'cg-1',
      agentAddress: '0xAbc',
      timestamp: '2026-04-02T00:00:00Z',
    };
    expect(isValidTransition(t.from, t.to)).toBe(true);
  });
});

describe('DraftDescriptor interface', () => {
  it('describes an agent draft', () => {
    const d: DraftDescriptor = {
      contextGraphId: 'cg-1',
      agentAddress: '0xAbc',
      name: 'my-draft',
      createdAt: '2026-04-02T00:00:00Z',
    };
    expect(d.name).toBe('my-draft');
  });
});

describe('ShareRecord interface', () => {
  it('describes a share operation', () => {
    const s: ShareRecord = {
      contextGraphId: 'cg-1',
      agentAddress: '0xAbc',
      operationId: 'op-1',
      entities: ['http://example.org/e1', 'http://example.org/e2'],
      tripleCount: 10,
      timestamp: '2026-04-02T00:00:00Z',
    };
    expect(s.entities).toHaveLength(2);
    expect(s.tripleCount).toBe(10);
  });
});
