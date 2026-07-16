// chat-acl.test.ts
//
// Unit-tests for the daemon's inbound-chat ACL helper. Exercises all four
// ACL modes (`any`, `peer-allowlist`, `scoped`, `shared-context-graph`)
// plus loopback and the fail-closed behaviour when a `scoped` ACL has
// no `contextGraphId` configured. Mocks `DashboardDB` with a minimal
// in-memory stand-in covering only the two helpers the ACL touches.

import { describe, it, expect } from 'vitest';
import { buildChatAcl } from '../src/daemon/chat-acl.js';
import type {
  ContextGraphMemberRow,
  ContextGraphSubscriptionRow,
  DashboardDB,
} from '@origintrail-official/dkg-node-ui';

const LOCAL_PEER = 'localPeerId';
const ALICE = '12D3KooWAlice';
const BOB = '12D3KooWBob';
const CAROL = '12D3KooWCarol';

function makeRow(
  cg: string,
  peerId: string,
  status: 'active' | 'removed' | 'pending' = 'active',
): ContextGraphMemberRow {
  return {
    context_graph_id: cg,
    principal_type: 'node',
    principal_id: peerId,
    role: null,
    status,
    source: null,
    display_name: null,
    metadata: null,
    first_seen_at: 0,
    updated_at: 0,
  };
}

function makeSub(cg: string, subscribed = 1): ContextGraphSubscriptionRow {
  return {
    context_graph_id: cg,
    name: null,
    subscribed,
    synced: 1,
    shared_memory_synced: 1,
    meta_synced: 1,
    on_chain_id: null,
    sync_scoped: 0,
    updated_at: 0,
  };
}

/**
 * Minimal `DashboardDB` stand-in covering only the methods the ACL helper
 * actually calls. Anything else throws so a mis-mock surfaces loudly.
 */
function makeDb(rows: {
  members?: Record<string, ContextGraphMemberRow[]>;
  subscriptions?: ContextGraphSubscriptionRow[];
}): DashboardDB {
  const stub: Partial<DashboardDB> = {
    listContextGraphMembers: (cg?: string) => {
      if (!cg) return Object.values(rows.members ?? {}).flat();
      return rows.members?.[cg] ?? [];
    },
    listContextGraphSubscriptions: () => rows.subscriptions ?? [],
  };
  return stub as DashboardDB;
}

describe('buildChatAcl', () => {
  // Default mode is `any` → null callback ⇒ MessageHandler accepts every
  // authenticated peer (legacy behaviour). Critical for backwards-compat
  // because nodes that haven't configured `chat.acl` shouldn't suddenly
  // start rejecting valid messages after this RFC lands.
  it('returns null when mode is unset', () => {
    const acl = buildChatAcl({
      dashDb: makeDb({}),
      getLocalPeerId: () => LOCAL_PEER,
    });
    expect(acl).toBeNull();
  });

  it('returns null when mode is "any"', () => {
    const acl = buildChatAcl({
      config: { mode: 'any' },
      dashDb: makeDb({}),
      getLocalPeerId: () => LOCAL_PEER,
    });
    expect(acl).toBeNull();
  });

  describe('mode: peer-allowlist', () => {
    it('accepts peers on the allowlist, rejects others', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [ALICE] },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl).not.toBeNull();
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      const denied = acl!(BOB, {});
      expect(denied.accept).toBe(false);
      expect(denied.reason).toMatch(/not in peer-allowlist/);
    });

    it('rejects everyone when allowlist is empty', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [] },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(false);
    });
  });

  describe('mode: scoped', () => {
    it('accepts senders that are active node-members of the scoped CG and surfaces the receiver-scope CG as verified', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({
          members: { 'cg-1': [makeRow('cg-1', ALICE)] },
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      // No claim from Alice — we still know which CG this is about
      // (the receiver's scope) so verifiedContextGraphId === 'cg-1'.
      expect(acl!(ALICE, {})).toEqual({ accept: true, verifiedContextGraphId: 'cg-1' });
      expect(acl!(BOB, {}).accept).toBe(false);
    });

    it('rejects senders whose membership is "removed" or "pending"', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({
          members: {
            'cg-1': [
              makeRow('cg-1', ALICE, 'removed'),
              makeRow('cg-1', BOB, 'pending'),
            ],
          },
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, {}).accept).toBe(false);
      expect(acl!(BOB, {}).accept).toBe(false);
    });

    it('fail-closes (rejects all) when contextGraphId is missing', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped' },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/no contextGraphId/);
    });

    it('reports CG mismatch when sender claims a different CG and is not a member', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({ members: { 'cg-1': [] } }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, { contextGraphId: 'cg-2' });
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/cg-2.*cg-1|cg-1.*cg-2/);
    });

    // Codex PR #510 round 2 — the spoof case: sender IS a valid
    // member of cg-1, but tags their message as belonging to cg-2.
    // Previously this returned `accept: true` and downstream
    // notifications/logs got tagged with the spoofed graph id.
    // Now the claim mismatch is rejected BEFORE the membership
    // check accepts.
    it('rejects a valid member of cg-1 who claims their message belongs to cg-2', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({
          members: { 'cg-1': [makeRow('cg-1', ALICE)] },
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      // Sanity: without a claim, alice is accepted with the
      // receiver-scope CG marked as verified.
      expect(acl!(ALICE, {})).toEqual({ accept: true, verifiedContextGraphId: 'cg-1' });
      // With a matching claim, still accepted with verified === claim.
      expect(acl!(ALICE, { contextGraphId: 'cg-1' })).toEqual({
        accept: true,
        verifiedContextGraphId: 'cg-1',
      });
      // With a spoof claim — must reject, NOT accept.
      const spoof = acl!(ALICE, { contextGraphId: 'cg-2' });
      expect(spoof.accept).toBe(false);
      expect(spoof.reason).toMatch(/cg-2.*cg-1|cg-1.*cg-2/);
    });
  });

  describe('mode: shared-context-graph', () => {
    it('accepts senders that share at least one subscribed CG (no claim → no verifiedContextGraphId)', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: {
            'cg-1': [makeRow('cg-1', ALICE)],
            'cg-2': [makeRow('cg-2', BOB)],
          },
          subscriptions: [makeSub('cg-1'), makeSub('cg-2')],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      // No claim → no verifiedContextGraphId (we don't guess).
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      expect(acl!(BOB, {})).toEqual({ accept: true });
      expect(acl!(CAROL, {}).accept).toBe(false);
    });

    it('ignores CGs that are no longer subscribed', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: { 'cg-1': [makeRow('cg-1', ALICE)] },
          subscriptions: [makeSub('cg-1', 0)],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/shares no active context-graph/i);
    });

    it('rejects with reason when no subscriptions exist', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({ subscriptions: [] }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, {}).accept).toBe(false);
    });

    // Same spoof family as the scoped mode test above, but for the
    // shared-context-graph case. If sender is a valid member of
    // (subscribed) graph cg-1 but claims cg-2, the verified graph
    // must drive the verdict — accepting and tagging downstream with
    // a spoofed cg-2 would be a graph-membership impersonation.
    it('rejects when sender claims a CG they are not a member of, even if they are a member of another subscribed CG', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: {
            'cg-1': [makeRow('cg-1', ALICE)],
            'cg-2': [], // we subscribe to cg-2 but Alice is NOT a member
          },
          subscriptions: [makeSub('cg-1'), makeSub('cg-2')],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      // No claim → accept (alice IS a member of cg-1 which we subscribe to).
      // verifiedContextGraphId stays undefined because we don't pick a CG
      // for the operator when the message itself wasn't tagged.
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      // Matching claim → accept with the verified claim surfaced.
      expect(acl!(ALICE, { contextGraphId: 'cg-1' })).toEqual({
        accept: true,
        verifiedContextGraphId: 'cg-1',
      });
      // Spoof claim (alice tags cg-2 but isn't a member there) → reject.
      const spoof = acl!(ALICE, { contextGraphId: 'cg-2' });
      expect(spoof.accept).toBe(false);
      expect(spoof.reason).toMatch(/cg-2.*not an active member/);
    });

    it('rejects when sender claims a CG we do not subscribe to', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: { 'cg-1': [makeRow('cg-1', ALICE)] },
          subscriptions: [makeSub('cg-1')],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, { contextGraphId: 'cg-99' });
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/cg-99.*does not subscribe/);
    });
  });

  describe('loopback', () => {
    it('always accepts when senderPeerId matches getLocalPeerId(), regardless of mode', () => {
      for (const mode of ['peer-allowlist', 'scoped', 'shared-context-graph'] as const) {
        const acl = buildChatAcl({
          config: {
            mode,
            // intentionally empty config — we want to prove loopback
            // wins even when the ACL would otherwise reject everyone.
            peerAllowlist: [],
            contextGraphId: 'cg-1',
          },
          dashDb: makeDb({}),
          getLocalPeerId: () => LOCAL_PEER,
        });
        expect(acl!(LOCAL_PEER, {})).toEqual({ accept: true });
      }
    });

    it('does not blow up if getLocalPeerId throws (agent not yet started)', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [ALICE] },
        dashDb: makeDb({}),
        getLocalPeerId: () => {
          throw new Error('not started');
        },
      });
      // Loopback check short-circuits; non-loopback path still works.
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      expect(acl!(BOB, {}).accept).toBe(false);
    });
  });

  // Codex PR #510 round 4/5 — the lifecycle.ts `chat_message`
  // notification title and the daemon's `CHAT IN` log line previously
  // included a `(cg=...)` suffix derived from `senderContextGraphId` —
  // the raw, attacker-controllable claim from the encrypted payload.
  // In `any` and `peer-allowlist` modes the ACL doesn't check the
  // claim, so an authenticated sender could stamp arbitrary CG ids
  // onto operator-facing surfaces. The fix surfaces a separate
  // `verifiedContextGraphId` from the verdict that downstream
  // consumers MUST prefer for display; this block is the cross-mode
  // contract for that field.
  describe('verifiedContextGraphId — cross-mode display contract', () => {
    it('is undefined in mode=any (no ACL → no verification possible)', () => {
      // mode=any returns null callback; downstream code never has a
      // verdict to read verifiedContextGraphId from. Confirmed via
      // the messaging.ts call site: when chatAclCheck is null,
      // verifiedContextGraphId stays `undefined` regardless of what
      // the sender claimed.
      const acl = buildChatAcl({
        config: { mode: 'any' },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl).toBeNull();
    });

    it('is undefined in mode=peer-allowlist (we authorise the peer, not their CG claim)', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [ALICE] },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      // Even with a claim, the verdict omits verifiedContextGraphId
      // because peer-allowlist mode never inspected it.
      const verdict = acl!(ALICE, { contextGraphId: 'cg-attacker' });
      expect(verdict.accept).toBe(true);
      expect(verdict.verifiedContextGraphId).toBeUndefined();
    });

    it('equals the receiver-scope CG in mode=scoped (claim or no-claim, both verified against config)', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-ok' },
        dashDb: makeDb({
          members: { 'cg-ok': [makeRow('cg-ok', ALICE)] },
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      // No claim → verified is the receiver's scope (we know the CG by config).
      expect(acl!(ALICE, {}).verifiedContextGraphId).toBe('cg-ok');
      // Matching claim → verified is the (now confirmed) claim.
      expect(acl!(ALICE, { contextGraphId: 'cg-ok' }).verifiedContextGraphId).toBe('cg-ok');
    });

    it('equals the verified claim in mode=shared-context-graph when a claim was made and matched a subscribed CG the sender is a member of', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: { 'cg-shared': [makeRow('cg-shared', ALICE)] },
          subscriptions: [makeSub('cg-shared')],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, { contextGraphId: 'cg-shared' }).verifiedContextGraphId).toBe('cg-shared');
    });

    it('is undefined in mode=shared-context-graph when sender did not claim a CG (we deliberately do not pick one)', () => {
      // Picking a shared CG to surface as "verified" when the sender
      // didn't tag the message would be guess-work: the sender might
      // be a member of multiple subscribed CGs and we have no way to
      // know which conversation context they intended. Safer to
      // leave the title untagged.
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: {
            'cg-1': [makeRow('cg-1', ALICE)],
            'cg-2': [makeRow('cg-2', ALICE)],
          },
          subscriptions: [makeSub('cg-1'), makeSub('cg-2')],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(true);
      expect(verdict.verifiedContextGraphId).toBeUndefined();
    });
  });

  it('rejects unknown modes (defence in depth)', () => {
    // Cast through `any` because we want to simulate a config we don't
    // statically know about — e.g. an operator hand-edited config.json
    // with a typo.
    const acl = buildChatAcl({
      config: { mode: 'totally-unknown' as any },
      dashDb: makeDb({}),
      getLocalPeerId: () => LOCAL_PEER,
    });
    expect(acl).not.toBeNull();
    const verdict = acl!(ALICE, {});
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/unknown ACL mode/);
  });
});
