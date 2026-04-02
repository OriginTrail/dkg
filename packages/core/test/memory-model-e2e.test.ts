import { describe, it, expect } from 'vitest';
import {
  MemoryLayer,
  TransitionType,
  isValidTransition,
  type MemoryTransition,
  type DraftDescriptor,
  type ShareRecord,
  type PublicationRequest,
  type Publication,
  type PublicationState,
  PUBLICATION_STATES,
} from '../src/memory-model.js';

describe('V10 memory model e2e: full lifecycle simulation', () => {
  const CG_ID = 'cg-42';
  const AGENT = '0xAbc123';

  it('WM → SWM → LTM → VM: complete forward progression', () => {
    const transitions: MemoryTransition[] = [];
    const layers: MemoryLayer[] = [
      MemoryLayer.WorkingMemory,
      MemoryLayer.SharedWorkingMemory,
      MemoryLayer.LongTermMemory,
      MemoryLayer.VerifiedMemory,
    ];

    for (let i = 0; i < layers.length - 1; i++) {
      expect(isValidTransition(layers[i], layers[i + 1])).toBe(true);
      transitions.push({
        from: layers[i],
        to: layers[i + 1],
        type: i === 0 ? TransitionType.CREATE : TransitionType.UPDATE,
        contextGraphId: CG_ID,
        agentAddress: AGENT,
        timestamp: new Date(Date.now() + i * 60_000).toISOString(),
      });
    }

    expect(transitions).toHaveLength(3);
    expect(transitions[0].from).toBe(MemoryLayer.WorkingMemory);
    expect(transitions[2].to).toBe(MemoryLayer.VerifiedMemory);
  });

  it('illegal backward transitions are rejected', () => {
    const layers = [
      MemoryLayer.VerifiedMemory,
      MemoryLayer.LongTermMemory,
      MemoryLayer.SharedWorkingMemory,
      MemoryLayer.WorkingMemory,
    ];

    for (let i = 0; i < layers.length - 1; i++) {
      expect(isValidTransition(layers[i], layers[i + 1])).toBe(false);
    }
  });

  it('skip transitions are rejected', () => {
    expect(isValidTransition(MemoryLayer.WorkingMemory, MemoryLayer.LongTermMemory)).toBe(false);
    expect(isValidTransition(MemoryLayer.WorkingMemory, MemoryLayer.VerifiedMemory)).toBe(false);
    expect(isValidTransition(MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiedMemory)).toBe(false);
  });

  it('Publication progresses through all states', () => {
    const request: PublicationRequest = {
      contextGraphId: CG_ID,
      triples: [
        { subject: 'http://example.org/alice', predicate: 'http://schema.org/name', object: '"Alice"' },
      ],
      transitionType: TransitionType.CREATE,
      authority: { type: 'owner', proofRef: 'sig:0xdeadbeef' },
    };

    const now = new Date();
    const pub: Publication = {
      publicationId: 'pub-lifecycle-1',
      request,
      status: 'accepted',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const happyPath: PublicationState[] = [
      'accepted', 'claimed', 'validated', 'broadcast', 'included', 'finalized',
    ];

    for (let i = 0; i < happyPath.length; i++) {
      pub.status = happyPath[i];
      pub.updatedAt = new Date(now.getTime() + (i + 1) * 1000).toISOString();

      switch (pub.status) {
        case 'claimed':
          pub.claim = { walletId: '0xWallet1', claimedAt: pub.updatedAt };
          break;
        case 'validated':
          pub.validation = {
            tripleCount: 1,
            merkleRoot: '0xbeef',
            validatedAt: pub.updatedAt,
          };
          break;
        case 'broadcast':
          pub.broadcast = { txHash: '0xfeed', broadcastAt: pub.updatedAt };
          break;
        case 'included':
          pub.inclusion = {
            blockNumber: 12345,
            blockTimestamp: pub.updatedAt,
            includedAt: pub.updatedAt,
          };
          break;
        case 'finalized':
          pub.finalization = {
            ual: `did:dkg:mock:31337/${AGENT}/1`,
            batchId: '1',
            finalizedAt: pub.updatedAt,
          };
          break;
      }
    }

    expect(pub.status).toBe('finalized');
    expect(pub.claim).toBeDefined();
    expect(pub.validation).toBeDefined();
    expect(pub.broadcast).toBeDefined();
    expect(pub.inclusion).toBeDefined();
    expect(pub.finalization).toBeDefined();
    expect(pub.failure).toBeUndefined();
  });

  it('Publication can fail at any state', () => {
    const failableStates: PublicationState[] = ['validated', 'broadcast', 'included'];

    for (const failState of failableStates) {
      const pub: Publication = {
        publicationId: `pub-fail-${failState}`,
        request: {
          contextGraphId: CG_ID,
          transitionType: TransitionType.CREATE,
          authority: { type: 'owner', proofRef: 'sig:0x...' },
        },
        status: 'failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        failure: {
          failedFromState: failState,
          phase: 'broadcast',
          code: 'NETWORK_ERROR',
          message: 'Connection refused',
          retryable: true,
          failedAt: new Date().toISOString(),
        },
      };
      expect(pub.failure!.failedFromState).toBe(failState);
    }
  });

  it('draft → share → publish → verify lifecycle with types', () => {
    // Step 1: Agent creates a draft (WM)
    const draft: DraftDescriptor = {
      contextGraphId: CG_ID,
      agentAddress: AGENT,
      name: 'game-turn-42',
      createdAt: new Date().toISOString(),
    };
    expect(draft.name).toBeTruthy();

    // Step 2: Agent shares to SWM
    const share: ShareRecord = {
      contextGraphId: CG_ID,
      agentAddress: AGENT,
      operationId: 'op-share-1',
      entities: ['http://example.org/alice', 'http://example.org/bob'],
      tripleCount: 10,
      timestamp: new Date().toISOString(),
    };
    expect(isValidTransition(MemoryLayer.WorkingMemory, MemoryLayer.SharedWorkingMemory)).toBe(true);
    expect(share.entities).toHaveLength(2);

    // Step 3: Publish from SWM → LTM
    const pubRequest: PublicationRequest = {
      contextGraphId: CG_ID,
      transitionType: TransitionType.CREATE,
      authority: { type: 'owner', proofRef: 'sig:0x...' },
      swmOperationId: share.operationId,
    };
    expect(isValidTransition(MemoryLayer.SharedWorkingMemory, MemoryLayer.LongTermMemory)).toBe(true);
    expect(pubRequest.swmOperationId).toBe('op-share-1');

    // Step 4: Verify from LTM → VM
    expect(isValidTransition(MemoryLayer.LongTermMemory, MemoryLayer.VerifiedMemory)).toBe(true);
  });
});
