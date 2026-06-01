/**
 * Regression coverage for issue #865 — UI "Open / publicly discoverable"
 * choice silently persisting as curated/invite-only after a follow-up
 * invite landed.
 *
 * Pre-#865 root cause: `DKGAgent.isPrivateContextGraph` fell through to
 * an "allowlist heuristic" whenever the explicit `accessPolicy` triple
 * was anything other than `"private"`. A user-invoked
 * `inviteToContextGraph` / `inviteAgentToContextGraph` would then write
 * a `DKG_ALLOWED_PEER` / `DKG_ALLOWED_AGENT` quad into `_meta`, the
 * heuristic would flip the CG to "private" on the next probe, and the
 * publisher would route Verifiable Memory publish through the curated
 * LU-5 / LU-11 chunked ACK path — which hangs indefinitely waiting for
 * invitee acknowledgements that never arrive on an actually-public CG.
 *
 * Post-#865: when the explicit `accessPolicy` triple says `"public"`,
 * `isPrivateContextGraph` returns false REGARDLESS of allowlist
 * presence. The allowlist heuristic stays as a legacy fallback only
 * for CGs that have no explicit policy at all (the pre-V10 discovery
 * case the original code was written for).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ONTOLOGY,
  Logger,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

const CG_ID = 'issue-865-public-cg';
const INVITEE_AGENT = '0x0000000000000000000000000000000000000865';
const INVITEE_PEER_ID = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CG_ID}`;

async function makeAgent() {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'Issue865Host',
    framework: 'DKG',
    listenPort: 0,
    store,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
  });
  await agent.start();
  return { agent, store };
}

async function ownerAddress(agent: DKGAgent): Promise<string> {
  // Mirror what the modal does: createContextGraph attributes ownership
  // to `defaultAgentAddress` when no `callerAgentAddress` is passed.
  // Surface it for the invite calls below so the owner check passes.
  return (agent as unknown as { defaultAgentAddress?: string }).defaultAgentAddress
    ?? (agent as unknown as { peerId: string }).peerId;
}

describe('Issue #865 — public CG + allowlist must not be classified as private', () => {
  it('createContextGraph({accessPolicy: 0}) followed by inviteAgentToContextGraph keeps the CG public', async () => {
    const { agent, store } = await makeAgent();
    try {
      const owner = await ownerAddress(agent);
      await agent.createContextGraph({
        id: CG_ID,
        name: 'Issue 865 Public CG',
        accessPolicy: 0,
        callerAgentAddress: owner,
      });

      // Sanity check: the modal's "Open / publicly discoverable" choice
      // lands as a `DKG_ACCESS_POLICY="public"` triple in the ontology
      // graph. This is the witness the post-#865 fix keys on.
      const policyResult = await store.query(
        `SELECT ?policy WHERE {
           GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
             <${CONTEXT_GRAPH_URI}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
           }
         }`,
      );
      expect(policyResult.type).toBe('bindings');
      if (policyResult.type === 'bindings') {
        expect(policyResult.bindings[0]?.['policy']).toBe('"public"');
      }

      await agent.inviteAgentToContextGraph(CG_ID, INVITEE_AGENT, owner);

      // The allowlist quad lands — that's still allowed (publishPolicy=
      // curated on a public-discoverable CG is a valid combo) — but
      // `isPrivateContextGraph` MUST not silently flip the CG to curated
      // just because of the quad's presence. That was the rc.12 bug.
      const allowlistResult = await store.query(
        `ASK WHERE {
           GRAPH <${contextGraphMetaUri(CG_ID)}> {
             <${CONTEXT_GRAPH_URI}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?a
           }
         }`,
      );
      expect(allowlistResult.type).toBe('boolean');
      if (allowlistResult.type === 'boolean') {
        expect(allowlistResult.value).toBe(true);
      }

      const isPrivate = await (agent as unknown as {
        isPrivateContextGraph(id: string): Promise<boolean>;
      }).isPrivateContextGraph(CG_ID);
      expect(isPrivate).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('explicit accessPolicy="public" overrides DKG_ALLOWED_PEER allowlist writes too', async () => {
    const { agent, store } = await makeAgent();
    try {
      const owner = await ownerAddress(agent);
      await agent.createContextGraph({
        id: CG_ID,
        name: 'Issue 865 Public CG (peer-invite variant)',
        accessPolicy: 0,
        callerAgentAddress: owner,
      });

      await agent.inviteToContextGraph(CG_ID, INVITEE_PEER_ID, owner);

      const peerListed = await store.query(
        `ASK WHERE {
           GRAPH <${contextGraphMetaUri(CG_ID)}> {
             <${CONTEXT_GRAPH_URI}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?p
           }
         }`,
      );
      expect(peerListed.type).toBe('boolean');
      if (peerListed.type === 'boolean') {
        expect(peerListed.value).toBe(true);
      }

      const isPrivate = await (agent as unknown as {
        isPrivateContextGraph(id: string): Promise<boolean>;
      }).isPrivateContextGraph(CG_ID);
      expect(isPrivate).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('explicit accessPolicy="private" still reports curated regardless of allowlist contents', async () => {
    // Mirror image of the previous tests — this guards against a fix
    // that over-corrects by ignoring `accessPolicy` entirely. Explicit
    // "private" must still win.
    const { agent } = await makeAgent();
    try {
      const owner = await ownerAddress(agent);
      await agent.createContextGraph({
        id: CG_ID,
        name: 'Issue 865 Private CG',
        accessPolicy: 1,
        allowedAgents: [owner],
        callerAgentAddress: owner,
      });

      const isPrivate = await (agent as unknown as {
        isPrivateContextGraph(id: string): Promise<boolean>;
      }).isPrivateContextGraph(CG_ID);
      expect(isPrivate).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  // Codex review on #873 — the `warnIfAllowlistWriteOnPublicCg` call
  // in `inviteToContextGraph` (peer path) used to run BEFORE the
  // idempotency early-return. A no-op re-invite would log "writing
  // allowlist quad" even though nothing got persisted, misleading
  // operators auditing their warn stream. The fix moved the call
  // AFTER the early-return; this test pins it.
  describe('Codex review on #873 — warn must not fire on no-op peer re-invite', () => {
    afterEach(() => {
      Logger.setSink(null);
    });

    it('inviteToContextGraph re-invite of an already-allowed peer on a public CG fires the warn exactly once', async () => {
      const warnings: string[] = [];
      Logger.setSink((entry) => {
        if (entry.level === 'warn') warnings.push(entry.message);
      });

      const { agent } = await makeAgent();
      try {
        const owner = await ownerAddress(agent);
        await agent.createContextGraph({
          id: CG_ID,
          name: 'Issue 865 Public CG (warn-ordering)',
          accessPolicy: 0,
          callerAgentAddress: owner,
        });

        // First invite — a real allowlist write happens, so the warn
        // MUST fire (the operator should see exactly one breadcrumb
        // explaining the allowlist landed on a public CG).
        await agent.inviteToContextGraph(CG_ID, INVITEE_PEER_ID, owner);

        const publicWarnsAfterFirst = warnings.filter((m) =>
          m.includes('inviteToContextGraph (peer)') &&
          m.includes('accessPolicy="public"'),
        );
        expect(publicWarnsAfterFirst).toHaveLength(1);

        // Second invite — peer is already in the allowlist, so the
        // idempotency branch returns early without inserting any
        // quad. The warn MUST NOT fire a second time, otherwise the
        // operator's audit trail shows phantom writes.
        await agent.inviteToContextGraph(CG_ID, INVITEE_PEER_ID, owner);

        const publicWarnsAfterSecond = warnings.filter((m) =>
          m.includes('inviteToContextGraph (peer)') &&
          m.includes('accessPolicy="public"'),
        );
        expect(publicWarnsAfterSecond).toHaveLength(1);
      } finally {
        await agent.stop().catch(() => {});
      }
    });
  });

  it('legacy CGs with no explicit accessPolicy + allowlist still report curated (back-compat with the heuristic fallback)', async () => {
    // The pre-#865 heuristic existed for a reason: V10 CGs discovered
    // via gossip without an ontology bootstrap genuinely have no
    // `accessPolicy` triple, and the only available curated signal is
    // the allowlist. The fix must preserve that fallback so the
    // store-discovery path doesn't misclassify a legitimately curated
    // legacy CG as open.
    const { agent, store } = await makeAgent();
    try {
      const cgMetaGraph = contextGraphMetaUri(CG_ID);
      await store.insert([
        // Note: no DKG_ACCESS_POLICY triple. Just the allowlist quad
        // a discovered curated CG would carry after a peer invite.
        {
          subject: CONTEXT_GRAPH_URI,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
          object: `"${INVITEE_PEER_ID}"`,
          graph: cgMetaGraph,
        },
      ]);

      const isPrivate = await (agent as unknown as {
        isPrivateContextGraph(id: string): Promise<boolean>;
      }).isPrivateContextGraph(CG_ID);
      expect(isPrivate).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
