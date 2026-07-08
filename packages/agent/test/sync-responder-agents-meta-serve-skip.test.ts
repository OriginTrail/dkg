import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Chunk 2 — responder serve-skip for the agents registry `_meta` graph (#1233).
 *
 * The agents registry system CG (`agents`) publishes a tentative per-heartbeat
 * KC/KA `_meta` record that has NO consumer (agent facts are served from the
 * DATA phase), so `agents/_meta` grows without bound. A core that keeps SERVING
 * that snapshot re-propagates the bloat across the mesh. The durable-meta
 * responder therefore withholds it BY DEFAULT — returning an empty (completed)
 * meta page — while leaving the DATA phase and every other CG's meta untouched.
 *
 * The skip is gated behind the runtime kill-switch `DKG_SERVE_AGENTS_META`
 * (this is the highest-blast-radius change, so it must be reversible without a
 * restart): default withholds; `DKG_SERVE_AGENTS_META=1` serves as before.
 */

const AGENTS_CG = SYSTEM_CONTEXT_GRAPHS.AGENTS; // 'agents'
const AGENTS_ENTITY = `did:dkg:context-graph:${AGENTS_CG}`;
const AGENTS_META = `${AGENTS_ENTITY}/_meta`;

const USER_CG = 'user-cg';
const USER_ENTITY = `did:dkg:context-graph:${USER_CG}`;
const USER_META = `${USER_ENTITY}/_meta`;

const DKG_NS = 'http://dkg.io/ontology/';

const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

const noopLog = (_ctx: OperationContext, _msg: string) => {};

// Captures the handler that registerSyncHandler installs so the test can drive
// it directly without a real libp2p stack (mirrors sync-responder-per-cgid-meta).
function captureHandler(): {
  register: (proto: string, h: (data: Uint8Array, peerId: string) => Promise<Uint8Array>) => void;
  invoke: (envelope: SyncRequestEnvelope) => Promise<string>;
} {
  let captured: ((data: Uint8Array, peerId: string) => Promise<Uint8Array>) | null = null;
  return {
    register: (_proto, h) => {
      captured = h;
    },
    invoke: async (envelope) => {
      if (!captured) throw new Error('handler not registered');
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      const out = await captured(bytes, REMOTE_PEER_ID);
      return new TextDecoder().decode(out);
    },
  };
}

function lineGraphsFromNquads(text: string): Set<string> {
  const graphs = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/<([^<>]+)>\s*\.\s*$/);
    if (m) graphs.add(m[1]);
  }
  return graphs;
}

describe('sync responder durable-meta phase — agents/_meta serve-skip', () => {
  let store: OxigraphStore;
  let cap: ReturnType<typeof captureHandler>;
  let originalServeFlag: string | undefined;

  beforeEach(async () => {
    originalServeFlag = process.env.DKG_SERVE_AGENTS_META;
    delete process.env.DKG_SERVE_AGENTS_META;

    store = new OxigraphStore();
    await store.insert([
      // agents/_meta: subject = cgEntity so it passes the durable-meta filter
      // (row.s === cgEntity). This is the no-consumer bloat we want withheld.
      { graph: AGENTS_META, subject: AGENTS_ENTITY, predicate: `${DKG_NS}createdAt`, object: '"2026-07-08T00:00:00Z"' },
      // agents DATA graph: an agent fact served by the DATA phase — must remain
      // served even while the meta phase is withheld.
      { graph: AGENTS_ENTITY, subject: AGENTS_ENTITY, predicate: `${DKG_NS}nodeRole`, object: '"core"' },
      // A NORMAL user CG's meta: subject = its cgEntity — must always be served.
      { graph: USER_META, subject: USER_ENTITY, predicate: `${DKG_NS}createdAt`, object: '"2026-07-08T00:00:00Z"' },
    ]);

    cap = captureHandler();
    registerSyncHandler({
      register: cap.register,
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      syncDeniedResponse: 'sync-denied',
      syncPageSize: 5000,
      sharedMemoryTtlMs: 0,
      store,
      peerId: 'self-peer',
      parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
      authorizeSyncRequest: async () => true,
      logWarn: noopLog,
      logDebug: noopLog,
    });
  });

  afterEach(() => {
    if (originalServeFlag === undefined) delete process.env.DKG_SERVE_AGENTS_META;
    else process.env.DKG_SERVE_AGENTS_META = originalServeFlag;
  });

  it('withholds durable meta for the agents registry CG by default (empty completed page)', async () => {
    const out = await cap.invoke({
      contextGraphId: AGENTS_CG,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'meta',
    });

    // Empty body === clean EOF for the requester (page-fetch: `if (!nquadsText) break`).
    expect(out.trim()).toBe('');
  });

  it('still serves durable meta for a normal user CG by default', async () => {
    const out = await cap.invoke({
      contextGraphId: USER_CG,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'meta',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(USER_META)).toBe(true);
    expect(out).toContain(USER_ENTITY);
  });

  it('leaves the agents-CG DATA phase intact while meta is withheld', async () => {
    const out = await cap.invoke({
      contextGraphId: AGENTS_CG,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'data',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(AGENTS_ENTITY)).toBe(true);
    expect(out).toContain(`${DKG_NS}nodeRole`);
  });

  it('serves agents durable meta normally when DKG_SERVE_AGENTS_META=1 (kill-switch)', async () => {
    process.env.DKG_SERVE_AGENTS_META = '1';

    const out = await cap.invoke({
      contextGraphId: AGENTS_CG,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'meta',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(AGENTS_META)).toBe(true);
    expect(out).toContain(`${DKG_NS}createdAt`);
  });
});
