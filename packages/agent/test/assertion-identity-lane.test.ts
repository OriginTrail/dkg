/**
 * Identity-allocation lane guard for `DKGAgent.get assertion()` (#2149).
 *
 * `assertion.create` and `assertion.migrateLegacyRootScopedWorkingMemory`
 * MUST resolve the author and mint the KA number through the same lane —
 * the graph-scoped KA identity a migration allocates has to be the one
 * create/write resolve later. These tests pin the shared
 * `resolveAuthorAndAllocator` wiring at the agent→publisher boundary with a
 * recording fake publisher, without booting a full agent (no Hardhat/libp2p:
 * the getter closure only touches `defaultAgentAddress`/`node.peerId` plus
 * the publisher/allocator fields, so a bare prototype instance suffices).
 */
import { describe, it, expect } from 'vitest';
import { DKGAgent } from '../src/index.js';

const EVM_AUTHOR = '0xbb765f337e251c1f18dfbec1a45ca56001b15e54';
const DEFAULT_EVM = '0x1111111111111111111111111111111111111111';
const PEER_ID = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';

function makeBareAgent(fields: Record<string, unknown>): any {
  const agent = Object.create(DKGAgent.prototype);
  Object.assign(agent, {
    kaNumberAllocator: {},
    chain: {},
    reconciledKaAuthors: new Set<string>(),
    ...fields,
  });
  return agent;
}

function recordingPublisher() {
  const createCalls: unknown[][] = [];
  const migrateCalls: unknown[][] = [];
  return {
    createCalls,
    migrateCalls,
    publisher: {
      assertionCreate: async (...args: unknown[]) => {
        createCalls.push(args);
        return 'urn:test:assertion';
      },
      migrateLegacyRootScopedWorkingMemory: async (...args: unknown[]) => {
        migrateCalls.push(args);
        return {
          status: 'not-needed',
          copiedPublic: 0,
          preservedPrivate: 0,
          sourceGraph: 'urn:test:source',
          backupGraph: 'urn:test:backup',
        };
      },
    },
  };
}

describe('DKGAgent assertion identity lane — create + legacy-WM migrate', () => {
  it(
    'migrate forwards contextGraphId, name, the EXPLICIT agentAddress, subGraphName, ' +
      'and an allocator callback to the publisher',
    async () => {
      const rec = recordingPublisher();
      const agent = makeBareAgent({
        defaultAgentAddress: DEFAULT_EVM,
        publisher: rec.publisher,
      });

      await agent.assertion.migrateLegacyRootScopedWorkingMemory('agent-context', 'chat-turns', {
        agentAddress: EVM_AUTHOR,
        subGraphName: 'sub-a',
      });

      expect(rec.migrateCalls).toHaveLength(1);
      const [contextGraphId, name, author, subGraphName, opts] = rec.migrateCalls[0]! as any[];
      expect(contextGraphId).toBe('agent-context');
      expect(name).toBe('chat-turns');
      expect(author).toBe(EVM_AUTHOR);
      expect(subGraphName).toBe('sub-a');
      expect(typeof opts?.allocateKaNumber).toBe('function');
    },
  );

  it('create and migrate resolve the identical author + allocator for the same opts', async () => {
    const rec = recordingPublisher();
    const agent = makeBareAgent({
      defaultAgentAddress: DEFAULT_EVM,
      publisher: rec.publisher,
    });

    await agent.assertion.create('agent-context', 'chat-turns', { agentAddress: EVM_AUTHOR });
    await agent.assertion.migrateLegacyRootScopedWorkingMemory('agent-context', 'chat-turns', {
      agentAddress: EVM_AUTHOR,
    });

    const createAuthor = (rec.createCalls[0] as any[])[2];
    const migrateAuthor = (rec.migrateCalls[0] as any[])[2];
    expect(createAuthor).toBe(EVM_AUTHOR);
    expect(migrateAuthor).toBe(EVM_AUTHOR);
    expect(typeof (rec.createCalls[0] as any[])[4]?.allocateKaNumber).toBe('function');
    expect(typeof (rec.migrateCalls[0] as any[])[4]?.allocateKaNumber).toBe('function');
  });

  it(
    'a non-EVM author (peerId fallback, no default agent) gets NO allocator on either ' +
      'lane — the draft falls back to the legacy name-keyed WM graph instead of hard-failing',
    async () => {
      const rec = recordingPublisher();
      const agent = makeBareAgent({
        defaultAgentAddress: undefined,
        node: { peerId: PEER_ID },
        publisher: rec.publisher,
      });

      await agent.assertion.create('agent-context', 'chat-turns');
      await agent.assertion.migrateLegacyRootScopedWorkingMemory('agent-context', 'chat-turns');

      expect((rec.createCalls[0] as any[])[2]).toBe(PEER_ID);
      expect((rec.migrateCalls[0] as any[])[2]).toBe(PEER_ID);
      expect((rec.createCalls[0] as any[])[4]?.allocateKaNumber).toBeUndefined();
      expect((rec.migrateCalls[0] as any[])[4]?.allocateKaNumber).toBeUndefined();
    },
  );

  it('without a configured kaNumberAllocator no lane mints identity, even for an EVM author', async () => {
    const rec = recordingPublisher();
    const agent = makeBareAgent({
      defaultAgentAddress: DEFAULT_EVM,
      kaNumberAllocator: undefined,
      publisher: rec.publisher,
    });

    await agent.assertion.create('agent-context', 'chat-turns', { agentAddress: EVM_AUTHOR });
    await agent.assertion.migrateLegacyRootScopedWorkingMemory('agent-context', 'chat-turns', {
      agentAddress: EVM_AUTHOR,
    });

    expect((rec.createCalls[0] as any[])[4]?.allocateKaNumber).toBeUndefined();
    expect((rec.migrateCalls[0] as any[])[4]?.allocateKaNumber).toBeUndefined();
  });
});
