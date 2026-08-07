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
 * while this daemon boundary owns publisher storage-upgrade concerns. The
 * migration is keyed to exactly `AGENT_CONTEXT_GRAPH`/`CHAT_TURNS_ASSERTION`
 * — the caller-selected assertion #2149 is about — so every other legacy KA
 * stays read-only, exactly as the publisher guarantees.
 */
import {
  AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
  type MemoryToolContext,
} from "@origintrail-official/dkg-node-ui";
import type { MemoryGraphChangedEvent } from "./routes/context.js";

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
): MemoryToolContext {
  return {
    query: (sparql, opts) => agent.query(sparql, opts),
    createAssertion: async (
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string; agentAddress?: string },
    ): Promise<{ assertionUri: string | null; alreadyExists: boolean }> => {
      // Upgraded nodes can still hold the pre-graph-scope, name-keyed
      // `agent-context/chat-turns` draft, which the normal create/write APIs
      // keep read-only by design. Front-load the one explicit,
      // data-preserving migration for exactly this assertion before ensuring
      // it exists (#2149); a healthy or absent draft resolves as
      // `not-needed` and costs one metadata lookup.
      //
      // Deliberately OUTSIDE the try below: that catch exists to make
      // `create` idempotent, and must never reinterpret a failed migration
      // as "the assertion already exists".
      if (contextGraphId === AGENT_CONTEXT_GRAPH && name === CHAT_TURNS_ASSERTION) {
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
