/**
 * Memory tool-context wiring for the daemon's `ChatMemoryManager`.
 *
 * Extracted from `runDaemonInner` so the production glue between the chat
 * memory layer and the DKG agent — the exact query/createAssertion/
 * writeAssertion surface, the memory-graph-changed emission, and the legacy
 * chat-WM migration (#2149) — is unit-testable without booting a daemon.
 * `resolveMemoryAgentAddress` in `lifecycle.ts` is the sibling contract for
 * WHICH agentAddress this context is driven with.
 *
 * The legacy migration lives HERE, not in `ChatMemoryManager`: the manager
 * describes the assertion it wants (`createAssertion` has ensure semantics),
 * while this daemon boundary owns publisher storage-upgrade concerns.
 *
 * Which assertion may migrate is DATA, not a hard-coded product branch: the
 * caller passes the same `{ contextGraphId, assertionName }` it constructs
 * `ChatMemoryManager` with, and only that exact pair migrates. Every other
 * legacy KA stays read-only, exactly as the publisher guarantees. Keeping the
 * pair a parameter is what makes an overridden chat-memory configuration
 * migrate its OWN assertion rather than silently migrating the package
 * defaults (or nothing at all).
 */
import {
  AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
  ChatMemoryManager,
  type LlmConfig,
  type MemoryToolContext,
} from "@origintrail-official/dkg-node-ui";
import type { MemoryGraphChangedEvent } from "./routes/context.js";

/**
 * The one assertion this tool context is allowed to storage-upgrade before
 * creating. Mirrors the chat-memory identifiers the manager is built with.
 */
export interface LegacyMigrationPolicy {
  contextGraphId: string;
  assertionName: string;
}

/** The minimal agent surface the memory tool context drives. */
export interface MemoryToolContextAgent {
  query(
    sparql: string,
    opts?: {
      contextGraphId?: string;
      graphSuffix?: "_shared_memory";
      includeSharedMemory?: boolean;
      view?: "working-memory" | "shared-working-memory" | "verifiable-memory";
      agentAddress?: string;
      assertionName?: string;
      subGraphName?: string;
    },
  ): Promise<any>;
  assertion: {
    create(
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string; agentAddress?: string },
    ): Promise<string>;
    write(
      contextGraphId: string,
      name: string,
      quads: any[],
      opts?: { subGraphName?: string; agentAddress?: string },
    ): Promise<unknown>;
    migrateLegacyRootScopedWorkingMemory(
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string; agentAddress?: string },
    ): Promise<unknown>;
  };
  createContextGraph(opts: {
    id: string;
    name: string;
    description?: string;
    private?: boolean;
  }): Promise<void>;
  listContextGraphs(): Promise<any[]>;
}

export function buildMemoryToolContext(
  agent: MemoryToolContextAgent,
  emitMemoryGraphChanged: (event: MemoryGraphChangedEvent) => void,
  legacyMigration: LegacyMigrationPolicy,
): MemoryToolContext {
  return {
    query: (sparql, opts) => agent.query(sparql, opts),
    createAssertion: async (
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string; agentAddress?: string },
    ): Promise<{ assertionUri: string | null; alreadyExists: boolean }> => {
      // Upgraded nodes can still hold the pre-graph-scope, name-keyed chat
      // draft, which the normal create/write APIs keep read-only by design.
      // Front-load the one explicit, data-preserving migration for exactly
      // the configured chat-memory assertion before ensuring it exists
      // (#2149); a healthy or absent draft resolves as `not-needed` and costs
      // one metadata lookup.
      //
      // Deliberately OUTSIDE the try below: that catch exists to make
      // `create` idempotent, and must never reinterpret a failed migration
      // as "the assertion already exists".
      if (
        contextGraphId === legacyMigration.contextGraphId
        && name === legacyMigration.assertionName
      ) {
        await agent.assertion.migrateLegacyRootScopedWorkingMemory(
          contextGraphId,
          name,
          opts,
        );
      }
      try {
        const assertionUri = await agent.assertion.create(
          contextGraphId,
          name,
          opts?.subGraphName || opts?.agentAddress
            ? { subGraphName: opts?.subGraphName, agentAddress: opts?.agentAddress }
            : undefined,
        );
        return { assertionUri, alreadyExists: false };
      } catch (err: any) {
        if (err?.message?.includes("already exists")) {
          return { assertionUri: null, alreadyExists: true };
        }
        throw err;
      }
    },
    writeAssertion: async (
      contextGraphId: string,
      name: string,
      quads: any[],
      opts?: { subGraphName?: string; agentAddress?: string },
    ): Promise<{ written: number }> => {
      await agent.assertion.write(
        contextGraphId,
        name,
        quads,
        opts?.subGraphName || opts?.agentAddress
          ? { subGraphName: opts?.subGraphName, agentAddress: opts?.agentAddress }
          : undefined,
      );
      emitMemoryGraphChanged({
        contextGraphId,
        layers: ["wm"],
        subGraphName: opts?.subGraphName,
        operation: "assertion_written",
        source: "agent_tool",
        counts: { triples: quads.length },
      });
      return { written: quads.length };
    },
    createContextGraph: (opts: {
      id: string;
      name: string;
      description?: string;
      private?: boolean;
    }) => agent.createContextGraph(opts),
    listContextGraphs: () => agent.listContextGraphs(),
  };
}

/**
 * Build the chat-memory stack as ONE unit.
 *
 * The safety property this exists to hold: the assertion the migration
 * policy may storage-upgrade is by construction the assertion
 * `ChatMemoryManager` writes to. Wiring them separately in `runDaemonInner`
 * left a gap where a future edit could hand one pair to the manager and
 * another to the policy — the manager would then write assertion A while
 * migration was permitted for assertion B, silently reinstating the #2149
 * failure with every test still green.
 *
 * Declaring the identifiers here and returning them alongside both objects
 * makes that invariant testable without booting a daemon, in the same
 * spirit as `resolveMemoryAgentAddress`.
 */
export function buildChatMemoryStack(input: {
  agent: MemoryToolContextAgent;
  emitMemoryGraphChanged: (event: MemoryGraphChangedEvent) => void;
  llmConfig: LlmConfig;
  agentAddress: string;
}): {
  chatMemoryIds: LegacyMigrationPolicy;
  toolContext: MemoryToolContext;
  manager: ChatMemoryManager;
} {
  const chatMemoryIds: LegacyMigrationPolicy = {
    contextGraphId: AGENT_CONTEXT_GRAPH,
    assertionName: CHAT_TURNS_ASSERTION,
  };
  const toolContext = buildMemoryToolContext(
    input.agent,
    input.emitMemoryGraphChanged,
    chatMemoryIds,
  );
  const manager = new ChatMemoryManager(toolContext, input.llmConfig, {
    agentAddress: input.agentAddress,
    contextGraphId: chatMemoryIds.contextGraphId,
    assertionName: chatMemoryIds.assertionName,
  });
  return { chatMemoryIds, toolContext, manager };
}
