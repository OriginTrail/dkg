/**
 * Daemon-wiring guard for `buildMemoryToolContext` — the production glue
 * between `ChatMemoryManager` and the DKG agent (#2149).
 *
 * Why this file exists: the node-ui tests construct the manager with their
 * own mock tool context, and the publisher tests exercise
 * `migrateLegacyRootScopedWorkingMemory` directly, so neither can catch a
 * regression in the MIDDLE of the migration path — the daemon forgetting to
 * migrate before create, migrating the wrong assertion, or dropping the
 * resolved `agentAddress` on the way to the agent. This file locks that glue
 * by exercising the extracted builder against a recording fake agent.
 *
 * Companion to `daemon-lifecycle-memory-agent-address.test.ts`, which locks
 * WHICH agentAddress the daemon drives this context with.
 */
import { describe, it, expect } from 'vitest';
import { buildMemoryToolContext, buildChatMemoryStack, type MemoryToolContextAgent } from '../src/daemon.js';

const CHAT_IDS = { contextGraphId: 'agent-context', assertionName: 'chat-turns' };

interface RecordingAgent extends MemoryToolContextAgent {
  order: string[];
  migrateCalls: unknown[][];
  createCalls: unknown[][];
  writeCalls: unknown[][];
}

function makeAgent(overrides?: {
  createImpl?: (...args: unknown[]) => Promise<string>;
  migrateImpl?: (...args: unknown[]) => Promise<unknown>;
}): RecordingAgent {
  const order: string[] = [];
  const migrateCalls: unknown[][] = [];
  const createCalls: unknown[][] = [];
  const writeCalls: unknown[][] = [];
  return {
    order,
    migrateCalls,
    createCalls,
    writeCalls,
    query: async () => ({ bindings: [] }),
    assertion: {
      create: async (...args: unknown[]) => {
        order.push('create');
        createCalls.push(args);
        if (overrides?.createImpl) return overrides.createImpl(...args);
        return 'urn:test:assertion';
      },
      write: async (...args: unknown[]) => {
        order.push('write');
        writeCalls.push(args);
        return undefined;
      },
      migrateLegacyRootScopedWorkingMemory: async (...args: unknown[]) => {
        order.push('migrate');
        migrateCalls.push(args);
        if (overrides?.migrateImpl) return overrides.migrateImpl(...args);
        return { status: 'not-needed', copiedPublic: 0, preservedPrivate: 0 };
      },
    },
    createContextGraph: async () => undefined,
    listContextGraphs: async () => [],
  } as RecordingAgent;
}

const AGENT_OPTS = { agentAddress: '0xbb765f337e251c1f18dfbec1a45ca56001b15e54' };

describe('buildMemoryToolContext — daemon chat-memory glue', () => {
  it(
    'createAssertion for agent-context/chat-turns migrates the legacy WM draft ' +
      'FIRST and forwards the same resolved agentAddress to both operations',
    async () => {
      const agent = makeAgent();
      const tools = buildMemoryToolContext(agent, () => {}, CHAT_IDS);

      const result = await tools.createAssertion('agent-context', 'chat-turns', AGENT_OPTS);

      expect(agent.order).toEqual(['migrate', 'create']);
      expect(agent.migrateCalls).toEqual([[
        'agent-context',
        'chat-turns',
        AGENT_OPTS,
      ]]);
      expect(agent.createCalls).toEqual([[
        'agent-context',
        'chat-turns',
        { subGraphName: undefined, agentAddress: AGENT_OPTS.agentAddress },
      ]]);
      expect(result).toEqual({ assertionUri: 'urn:test:assertion', alreadyExists: false });
    },
  );

  it('forwards subGraphName alongside agentAddress through the migration call', async () => {
    const agent = makeAgent();
    const tools = buildMemoryToolContext(agent, () => {}, CHAT_IDS);

    await tools.createAssertion('agent-context', 'chat-turns', {
      subGraphName: 'sub-a',
      agentAddress: AGENT_OPTS.agentAddress,
    });

    expect(agent.migrateCalls[0]?.[2]).toEqual({
      subGraphName: 'sub-a',
      agentAddress: AGENT_OPTS.agentAddress,
    });
  });

  it(
    'createAssertion for any OTHER assertion never migrates — the legacy ' +
      'migration is scoped to exactly the chat-turns WM draft (#2149)',
    async () => {
      const agent = makeAgent();
      const tools = buildMemoryToolContext(agent, () => {}, CHAT_IDS);

      await tools.createAssertion('agent-context', 'other-assertion', AGENT_OPTS);
      await tools.createAssertion('other-graph', 'chat-turns', AGENT_OPTS);

      expect(agent.migrateCalls).toHaveLength(0);
      expect(agent.createCalls).toHaveLength(2);
    },
  );

  it('maps "already exists" from create to alreadyExists (migration still ran)', async () => {
    const agent = makeAgent({
      createImpl: async () => {
        throw new Error('assertion already exists');
      },
    });
    const tools = buildMemoryToolContext(agent, () => {}, CHAT_IDS);

    const result = await tools.createAssertion('agent-context', 'chat-turns', AGENT_OPTS);

    expect(agent.order).toEqual(['migrate', 'create']);
    expect(result).toEqual({ assertionUri: null, alreadyExists: true });
  });

  it(
    'a migration failure whose message happens to contain "already exists" still ' +
      'propagates — the idempotent-create catch must not absorb a failed migration',
    async () => {
      const agent = makeAgent({
        migrateImpl: async () => {
          throw new Error('legacy backup graph already exists');
        },
      });
      const tools = buildMemoryToolContext(agent, () => {}, CHAT_IDS);

      await expect(
        tools.createAssertion('agent-context', 'chat-turns', AGENT_OPTS),
      ).rejects.toThrow(/already exists/);
      expect(agent.createCalls).toHaveLength(0);
    },
  );

  it('propagates a coded migration refusal instead of swallowing it', async () => {
    const refusal = Object.assign(
      new Error('Legacy WM migration refused for agent-context/chat-turns: only an active, local created/WM draft is eligible'),
      { code: 'KA_LEGACY_WM_MIGRATION_REFUSED' },
    );
    const agent = makeAgent({
      migrateImpl: async () => {
        throw refusal;
      },
    });
    const tools = buildMemoryToolContext(agent, () => {}, CHAT_IDS);

    await expect(
      tools.createAssertion('agent-context', 'chat-turns', AGENT_OPTS),
    ).rejects.toMatchObject({ code: 'KA_LEGACY_WM_MIGRATION_REFUSED' });
    expect(agent.createCalls).toHaveLength(0);
  });

  it(
    'the migration policy follows the CONFIGURED chat-memory identifiers, not the ' +
      'package defaults — an overridden manager migrates its own assertion',
    async () => {
      const agent = makeAgent();
      const tools = buildMemoryToolContext(agent, () => {}, {
        contextGraphId: 'custom-context',
        assertionName: 'custom-turns',
      });

      // The configured pair migrates...
      await tools.createAssertion('custom-context', 'custom-turns', AGENT_OPTS);
      expect(agent.migrateCalls).toEqual([[
        'custom-context',
        'custom-turns',
        AGENT_OPTS,
      ]]);

      // ...and the package DEFAULT pair no longer does, because it is not
      // what this manager writes to.
      await tools.createAssertion('agent-context', 'chat-turns', AGENT_OPTS);
      expect(agent.migrateCalls).toHaveLength(1);
      expect(agent.createCalls).toHaveLength(2);
    },
  );

  it('writeAssertion forwards agentAddress and emits one wm memory-graph-changed event', async () => {
    const agent = makeAgent();
    const events: any[] = [];
    const tools = buildMemoryToolContext(agent, (event) => events.push(event), CHAT_IDS);

    const result = await tools.writeAssertion(
      'agent-context',
      'chat-turns',
      [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: '' }],
      AGENT_OPTS,
    );

    expect(agent.writeCalls).toEqual([[
      'agent-context',
      'chat-turns',
      [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: '' }],
      { subGraphName: undefined, agentAddress: AGENT_OPTS.agentAddress },
    ]]);
    expect(result).toEqual({ written: 1 });
    expect(events).toEqual([
      expect.objectContaining({
        contextGraphId: 'agent-context',
        layers: ['wm'],
        operation: 'assertion_written',
        source: 'agent_tool',
        counts: { triples: 1 },
      }),
    ]);
  });
});

describe('buildChatMemoryStack — the manager and the migration policy cannot diverge', () => {
  // The #2149 failure returns silently if the manager writes assertion A
  // while migration is permitted for assertion B. Building both from one
  // identifier declaration is the production safety property; this locks it
  // at the seam `runDaemonInner` actually calls.
  it('migrates exactly the assertion the manager is configured to write to', async () => {
    const agent = makeAgent();
    const { chatMemoryIds, toolContext, manager } = buildChatMemoryStack({
      agent,
      emitMemoryGraphChanged: () => {},
      llmConfig: { apiKey: '' },
      agentAddress: AGENT_OPTS.agentAddress,
    });

    // BOTH halves are read back off the MANAGER, never off the policy the
    // context was built from — comparing the policy to itself would leave
    // the exact divergence this test exists to catch invisible.
    expect(manager.contextGraphId).toBe(chatMemoryIds.contextGraphId);
    expect(manager.assertionName).toBe(chatMemoryIds.assertionName);

    // Driving createAssertion with the manager's OWN identifiers must
    // trigger the migration. If a future edit handed different pairs to the
    // two halves, this call would not migrate.
    await toolContext.createAssertion(
      manager.contextGraphId,
      manager.assertionName,
      AGENT_OPTS,
    );
    expect(agent.order).toEqual(['migrate', 'create']);
    expect(agent.migrateCalls[0]?.[0]).toBe(manager.contextGraphId);
    expect(agent.migrateCalls[0]?.[1]).toBe(manager.assertionName);
  });

  it('forwards the resolved agentAddress into the manager', () => {
    const { manager } = buildChatMemoryStack({
      agent: makeAgent(),
      emitMemoryGraphChanged: () => {},
      llmConfig: { apiKey: '' },
      agentAddress: AGENT_OPTS.agentAddress,
    });
    expect(manager.agentAddress).toBe(AGENT_OPTS.agentAddress);
  });
});
