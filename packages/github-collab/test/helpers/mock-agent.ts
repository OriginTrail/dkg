/**
 * Mock DKG agent factory for unit/integration tests.
 *
 * Follows the same pattern as origin-trail-game's makeMockAgent().
 * All write operations are tracked in internal arrays so tests can
 * assert what was published, written to workspace, etc.
 */

export function makeMockAgent(peerId = 'test-peer-1') {
  const published: any[] = [];
  const workspaceWrites: any[] = [];
  const conditionalWrites: any[] = [];
  const enshrined: any[] = [];
  const contextGraphs: any[] = [];
  const subscriptions = new Set<string>();
  const messageHandlers = new Map<string, Function[]>();

  return {
    peerId,
    identityId: 0n,
    gossip: {
      subscribe(topic: string) {
        subscriptions.add(topic);
      },
      publish: async (_topic: string, _data: Uint8Array) => {},
      onMessage(topic: string, handler: Function) {
        if (!messageHandlers.has(topic)) messageHandlers.set(topic, []);
        messageHandlers.get(topic)!.push(handler);
      },
      offMessage(_topic: string, _handler: Function) {},
    },

    writeToWorkspace: async (_paranetId: string, quads: any[]) => {
      workspaceWrites.push(quads);
      return { workspaceOperationId: `ws-op-${workspaceWrites.length}` };
    },
    writeConditionalToWorkspace: async (_paranetId: string, quads: any[], conditions: any[]) => {
      workspaceWrites.push(quads);
      conditionalWrites.push({ quads, conditions });
      return { workspaceOperationId: `ws-op-cas-${conditionalWrites.length}` };
    },

    publish: async (_paranetId: string, quads: any[]): Promise<any> => {
      published.push(quads);
      return { onChainResult: { txHash: '0xabc123' }, ual: 'did:dkg:test:ual' };
    },

    enshrineFromWorkspace: async (_paranetId: string, selection: any, options?: any) => {
      enshrined.push({ selection, options });
      return { onChainResult: { txHash: '0xenshrine123', blockNumber: 100 }, ual: 'did:dkg:test:enshrined' };
    },

    createContextGraph: async (params: any) => {
      const id = BigInt(contextGraphs.length + 1);
      contextGraphs.push(params);
      return { contextGraphId: id, success: true };
    },
    signContextGraphDigest: async (_contextGraphId: bigint, _merkleRoot: Uint8Array) => ({
      identityId: 0n,
      r: new Uint8Array(32),
      vs: new Uint8Array(32),
    }),

    query: async (_sparql?: string, _paranetId?: string) => ({ bindings: [] }),

    // --- tracking arrays for test assertions ---
    _published: published,
    _workspaceWrites: workspaceWrites,
    _conditionalWrites: conditionalWrites,
    _enshrined: enshrined,
    _contextGraphs: contextGraphs,
    _subscriptions: subscriptions,
    _messageHandlers: messageHandlers,

    /** Simulate an incoming gossip message. */
    _injectMessage(topic: string, data: Uint8Array, from: string) {
      for (const handler of messageHandlers.get(topic) ?? []) {
        handler(topic, data, from);
      }
    },
  };
}

export type MockAgent = ReturnType<typeof makeMockAgent>;
