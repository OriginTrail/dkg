/**
 * Regression test for GitHub issue #277.
 *
 * Symptom: `/api/openclaw-channel/persist-turn` returns HTTP 200 and
 * `ChatMemoryManager.storeChatExchange` reports success, but
 * `getRecentChats()` returns `{ sessions: [] }` and `getSession()`
 * returns `null` for the same session that was just persisted.
 *
 * Root cause: chat-turn WRITES flow through `agent.assertion.write`
 * which internally resolves the assertion graph URI from
 * `defaultAgentAddress ?? peerId` (see
 * `packages/agent/src/dkg-agent.ts::get assertion()`). Reads were
 * configured with `{ agentAddress: agent.peerId }` — a fixed peerId.
 * When the node has a default agent registered (the production case:
 * `autoRegisterDefaultAgent` runs on boot whenever an operational key
 * exists, and operators register agents explicitly), `defaultAgentAddress`
 * is the agent's EVM address, NOT the libp2p peerId. Writes land in
 *   `did:dkg:context-graph:<cg>/assertion/<evmAddress>/<assertion>`
 * while reads query
 *   `did:dkg:context-graph:<cg>/assertion/<peerId>/<assertion>`
 * — a structurally different graph URI (see
 * `packages/core/src/constants.ts::contextGraphAssertionUri`).
 *
 * The fix in `packages/cli/src/daemon/lifecycle.ts` configures
 * ChatMemoryManager with `agent.getDefaultAgentAddress() ?? agent.peerId`
 * so writes and reads resolve to the same assertion graph URI.
 *
 * This test uses a lightweight `MemoryToolContext` fake that models
 * only the one invariant that matters for #277: writes and reads of
 * `view: 'working-memory'` must route through the same
 * `contextGraphAssertionUri(cg, agentAddress, assertion)` key. No chain,
 * no libp2p, no hardhat — we pin the wiring contract directly.
 */
import { describe, it, expect } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';
import { contextGraphAssertionUri } from '@origintrail-official/dkg-core';

// `agent.assertion.write` internally uses `defaultAgentAddress ?? peerId`
// to key the assertion graph URI, so our fake models the exact same
// dispatch. Writes are keyed by the fake's `writeAgentAddress` (the
// value the production wrapper forwards to `agent.assertion.write`).
// Reads are keyed by the `agentAddress` ChatMemoryManager passes in its
// WM query options.
function buildStoreBackedTools(writeAgentAddress: string) {
  // graphUri -> quads written under it
  const store = new Map<string, any[]>();

  const tools = {
    query: async (
      sparql: string,
      opts?: {
        contextGraphId?: string;
        view?: string;
        agentAddress?: string;
        assertionName?: string;
      },
    ) => {
      if (opts?.view !== 'working-memory' || !opts.contextGraphId || !opts.agentAddress || !opts.assertionName) {
        return { bindings: [] };
      }
      const graphUri = contextGraphAssertionUri(
        opts.contextGraphId,
        opts.agentAddress,
        opts.assertionName,
      );
      const quads = store.get(graphUri) ?? [];
      return executeMiniSparql(sparql, quads);
    },
    share: async () => ({ shareOperationId: 'noop' }),
    createAssertion: async (contextGraphId: string, name: string) => {
      const graphUri = contextGraphAssertionUri(contextGraphId, writeAgentAddress, name);
      if (!store.has(graphUri)) store.set(graphUri, []);
      return { assertionUri: graphUri, alreadyExists: false };
    },
    writeAssertion: async (contextGraphId: string, name: string, quads: any[]) => {
      const graphUri = contextGraphAssertionUri(contextGraphId, writeAgentAddress, name);
      const bucket = store.get(graphUri) ?? [];
      bucket.push(...quads);
      store.set(graphUri, bucket);
      return { written: quads.length };
    },
    publishFromSharedMemory: async () => ({}),
    createContextGraph: async () => {},
    listContextGraphs: async () => [{ id: 'agent-context', name: 'Agent Context' }],
  };

  return { tools, store };
}

// Minimal SPARQL "executor" sufficient for `getRecentChats` and
// `getSession`'s query shapes. It's not general — it runs against the
// bucket of quads for the resolved assertion graph and answers the
// specific patterns ChatMemoryManager emits.
function executeMiniSparql(sparql: string, quads: any[]): any {
  const s = sparql.replace(/\s+/g, ' ').trim();
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const SCHEMA = 'http://schema.org/';
  const DKG_ONT = 'http://dkg.io/ontology/';

  // Known sessions prefetch:
  //   SELECT ?sid WHERE { ?s rdf:type schema:Conversation . ?s dkg:sessionId ?sid }
  if (s.includes('SELECT ?sid') && s.includes('sessionId')) {
    const bindings: any[] = [];
    for (const q of quads) {
      if (q.predicate === `${DKG_ONT}sessionId`) {
        bindings.push({ sid: q.object });
      }
    }
    return { bindings };
  }

  // getRecentChats sessions query:
  //   SELECT ?s ?sid (MAX(?mts) AS ?latest) WHERE { ?s a schema:Conversation . ?s dkg:sessionId ?sid . OPTIONAL { ?m schema:isPartOf ?s . ?m schema:dateCreated ?mts } }
  if (s.includes('(MAX(?mts) AS ?latest)')) {
    const sessions = new Map<string, string>();
    for (const q of quads) {
      if (q.predicate === `${DKG_ONT}sessionId`) {
        sessions.set(q.subject, String(q.object));
      }
    }
    const bindings = [...sessions.entries()].map(([s, sid]) => ({ s, sid }));
    return { bindings };
  }

  // getRecentChats messages query:
  //   SELECT ?session ?author ?text ?ts WHERE { VALUES ?session { ... } ?m schema:isPartOf ?session . ?m schema:author ?author . ?m schema:text ?text . ?m schema:dateCreated ?ts }
  if (s.includes('SELECT ?session ?author ?text ?ts') && s.includes('VALUES ?session')) {
    const match = s.match(/VALUES \?session \{ ([^}]+) \}/);
    const sessionUris = match
      ? [...match[1].matchAll(/<([^>]+)>/g)].map((m) => m[1])
      : [];
    const bySession = new Map<string, { author: string; text: string; ts: string }[]>();
    for (const q of quads) {
      if (q.predicate === `${SCHEMA}isPartOf` && sessionUris.includes(q.object)) {
        const msg = q.subject;
        const authorQ = quads.find((x) => x.subject === msg && x.predicate === `${SCHEMA}author`);
        const textQ = quads.find((x) => x.subject === msg && x.predicate === `${SCHEMA}text`);
        const tsQ = quads.find((x) => x.subject === msg && x.predicate === `${SCHEMA}dateCreated`);
        if (!authorQ || !textQ || !tsQ) continue;
        const list = bySession.get(q.object) ?? [];
        list.push({
          session: q.object,
          author: authorQ.object,
          text: textQ.object,
          ts: tsQ.object,
        } as any);
        bySession.set(q.object, list);
      }
    }
    const bindings: any[] = [];
    for (const [session, msgs] of bySession.entries()) {
      for (const msg of msgs) {
        bindings.push({ session, ...msg });
      }
    }
    return { bindings };
  }

  // getSession messages query:
  //   SELECT ?m ?author ?text ?ts ?turnId ?persistenceState ?attachmentRefs ?failureReason WHERE { ?m schema:isPartOf <session> ... }
  if (s.includes('SELECT ?m ?author ?text ?ts') && s.includes('isPartOf')) {
    const sessionMatch = s.match(/isPartOf> <([^>]+)>/);
    const sessionUri = sessionMatch?.[1];
    if (!sessionUri) return { bindings: [] };
    const bindings: any[] = [];
    for (const q of quads) {
      if (q.predicate === `${SCHEMA}isPartOf` && q.object === sessionUri) {
        const msg = q.subject;
        const authorQ = quads.find((x) => x.subject === msg && x.predicate === `${SCHEMA}author`);
        const textQ = quads.find((x) => x.subject === msg && x.predicate === `${SCHEMA}text`);
        const tsQ = quads.find((x) => x.subject === msg && x.predicate === `${SCHEMA}dateCreated`);
        if (!authorQ || !textQ || !tsQ) continue;
        bindings.push({
          m: msg,
          author: authorQ.object,
          text: textQ.object,
          ts: tsQ.object,
        });
      }
    }
    return { bindings };
  }

  // Stats / counts / other queries — not exercised by this regression test.
  return { bindings: [] };
}

describe('issue #277 — OpenClaw chat-turn persistence round-trip', () => {
  const EVM_ADDR = '0xbb765f337e251c1f18dfbec1a45ca56001b15e54';
  const PEER_ID = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';

  it(
    'pre-fix wiring (reads keyed on peerId while writes land under defaultAgentAddress) ' +
      'reproduces the empty read — contract pin for why the fix matters',
    async () => {
      // `agent.assertion.write` resolves to `defaultAgentAddress ?? peerId`;
      // with a default agent registered (production norm) this is the EVM
      // address. The fake routes writes accordingly.
      const { tools } = buildStoreBackedTools(EVM_ADDR);

      // BUGGY wiring: reads keyed on peerId — pre-fix lifecycle.ts.
      const manager = new ChatMemoryManager(tools as any, { apiKey: '' }, {
        agentAddress: PEER_ID,
      });

      await manager.storeChatExchange('openclaw:dkg-ui', 'hello', 'reply', undefined, {
        turnId: 'turn-1',
      });

      const recent = await manager.getRecentChats(5);
      expect(
        recent,
        'this mis-wiring is the exact shape of #277: storeChatExchange ' +
          'reports success but getRecentChats returns [] because reads ' +
          'query a different assertion graph URI than writes landed in',
      ).toHaveLength(0);

      const session = await manager.getSession('openclaw:dkg-ui');
      expect(
        session,
        'getSession returns null for the same reason — peerId-keyed WM ' +
          'graph URI is structurally different from EVM-keyed write URI',
      ).toBeNull();
    },
  );

  it(
    'fixed wiring (reads and writes keyed on the same agentAddress) surfaces ' +
      'the stored chat turn on immediate getRecentChats / getSession — the ' +
      'invariant lifecycle.ts must preserve',
    async () => {
      // The fix in `packages/cli/src/daemon/lifecycle.ts` configures
      // ChatMemoryManager with `agent.getDefaultAgentAddress() ?? agent.peerId`
      // — the SAME value `agent.assertion.write` resolves internally.
      const { tools } = buildStoreBackedTools(EVM_ADDR);
      const manager = new ChatMemoryManager(tools as any, { apiKey: '' }, {
        agentAddress: EVM_ADDR,
      });

      await manager.storeChatExchange(
        'openclaw:dkg-ui',
        'hello from user',
        'reply from agent',
        undefined,
        { turnId: 'turn-1' },
      );

      const recent = await manager.getRecentChats(5);
      expect(recent).toHaveLength(1);
      expect(recent[0].session).toBe('openclaw:dkg-ui');
      expect(recent[0].messages.length).toBeGreaterThanOrEqual(2);

      const session = await manager.getSession('openclaw:dkg-ui');
      expect(session).not.toBeNull();
      expect(session!.session).toBe('openclaw:dkg-ui');
      expect(session!.messages.some((m) => m.text === 'hello from user')).toBe(true);
      expect(session!.messages.some((m) => m.text === 'reply from agent')).toBe(true);
    },
  );
});
