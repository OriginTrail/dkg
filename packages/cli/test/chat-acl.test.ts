import { describe, expect, it } from 'vitest';
import type { ContextGraphMemberRow, DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  DEFAULT_CHAT_MAX_MESSAGES_PER_MINUTE,
  DEFAULT_CHAT_MAX_TEXT_BYTES,
  buildChatAcl,
} from '../src/daemon/chat-acl.js';

const LOCAL = '12D3KooWLocal';
const ALICE = '12D3KooWAlice';
const BOB = '12D3KooWBob';

function member(
  cg: string,
  peerId: string,
  overrides: Partial<ContextGraphMemberRow> = {},
): ContextGraphMemberRow {
  return {
    context_graph_id: cg,
    principal_type: 'node',
    principal_id: peerId,
    role: 'participant',
    status: 'active',
    source: 'allowed-peer',
    display_name: null,
    metadata: null,
    first_seen_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function db(members: Record<string, ContextGraphMemberRow[]> = {}): DashboardDB {
  return {
    listContextGraphMembers: (cg?: string) =>
      cg ? (members[cg] ?? []) : Object.values(members).flat(),
    listContextGraphSubscriptions: () => [],
  } as unknown as DashboardDB;
}

function payload(contextGraphId?: string, textBytes = 1) {
  return { ...(contextGraphId ? { contextGraphId } : {}), textBytes };
}

describe('buildChatAcl secure defaults', () => {
  it('rejects every remote and loopback peer when chat config is omitted', () => {
    const acl = buildChatAcl({ dashDb: db(), getLocalPeerId: () => LOCAL });
    expect(acl(ALICE, payload()).reason).toMatch(/disabled/);
    expect(acl(LOCAL, payload()).accept).toBe(false);
  });

  it('does not let an ACL mode bypass chat.enabled', () => {
    const acl = buildChatAcl({
      config: { acl: { mode: 'any' }, allowLoopback: true },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(acl(ALICE, payload()).accept).toBe(false);
    expect(acl(LOCAL, payload()).accept).toBe(false);
  });

  it('defaults an enabled listener to deny', () => {
    const acl = buildChatAcl({
      config: { enabled: true },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(acl(ALICE, payload()).reason).toMatch(/deny/);
  });

  it('only permits loopback when explicitly enabled', () => {
    const denied = buildChatAcl({
      config: { enabled: true, acl: { mode: 'deny' } },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    const allowed = buildChatAcl({
      config: { enabled: true, allowLoopback: true, acl: { mode: 'deny' } },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(denied(LOCAL, payload()).accept).toBe(false);
    expect(allowed(LOCAL, payload())).toEqual({ accept: true });
  });
});

describe('buildChatAcl mode=trusted access matrix', () => {
  const trustedCg = 'cg-trusted';
  const otherCg = 'cg-other';

  function trustedAcl(rows: Record<string, ContextGraphMemberRow[]> = {}) {
    return buildChatAcl({
      config: {
        enabled: true,
        acl: {
          mode: 'trusted',
          peerAllowlist: [ALICE],
          trustedContextGraphIds: [trustedCg],
        },
      },
      dashDb: db(rows),
      getLocalPeerId: () => LOCAL,
    });
  }

  it('accepts an exact trusted machine without a CG claim', () => {
    expect(trustedAcl()(ALICE, payload())).toEqual({ accept: true });
  });

  it('rejects an unknown machine without a CG claim', () => {
    expect(trustedAcl()(BOB, payload()).reason).toMatch(/no trusted contextGraphId claim/);
  });

  it('accepts a trusted-CG peer only with an explicit matching claim', () => {
    const acl = trustedAcl({ [trustedCg]: [member(trustedCg, BOB)] });
    expect(acl(BOB, payload()).accept).toBe(false);
    expect(acl(BOB, payload(trustedCg))).toEqual({
      accept: true,
      verifiedContextGraphId: trustedCg,
    });
  });

  it('rejects a member that claims a CG not explicitly trusted for chat', () => {
    const acl = trustedAcl({ [otherCg]: [member(otherCg, BOB)] });
    expect(acl(BOB, payload(otherCg)).reason).toMatch(/not explicitly trusted/);
  });

  it.each([
    ['removed membership', { status: 'removed' }],
    ['pending membership', { status: 'pending' }],
    ['agent principal', { principal_type: 'agent' }],
    ['ambient discovery source', { source: 'on-chain-registration' }],
    ['implicit write source', { source: 'implicit-swm-write' }],
  ] as const)('rejects %s', (_label, overrides) => {
    const acl = trustedAcl({
      [trustedCg]: [member(trustedCg, BOB, overrides as Partial<ContextGraphMemberRow>)],
    });
    expect(acl(BOB, payload(trustedCg)).reason).toMatch(
      /no active curator-managed peer membership/,
    );
  });

  it('rejects a peer that is not a member of the claimed trusted CG', () => {
    const acl = trustedAcl({ [trustedCg]: [member(trustedCg, ALICE)] });
    expect(acl(BOB, payload(trustedCg)).accept).toBe(false);
  });
});

describe('buildChatAcl resource limits', () => {
  it('enforces the configured UTF-8 byte limit after trust succeeds', () => {
    const acl = buildChatAcl({
      config: {
        enabled: true,
        acl: { mode: 'trusted', peerAllowlist: [ALICE] },
        limits: { maxTextBytes: 4 },
      },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(acl(ALICE, payload(undefined, 4)).accept).toBe(true);
    expect(acl(ALICE, payload(undefined, 5)).reason).toMatch(/exceeds 4/);
  });

  it('enforces a rolling per-peer rate limit and resets after one minute', () => {
    let time = 1_000;
    const acl = buildChatAcl({
      config: {
        enabled: true,
        acl: { mode: 'trusted', peerAllowlist: [ALICE, BOB] },
        limits: { maxMessagesPerMinute: 2 },
      },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
      now: () => time,
    });
    expect(acl(ALICE, payload()).accept).toBe(true);
    expect(acl(ALICE, payload()).accept).toBe(true);
    expect(acl(ALICE, payload()).reason).toMatch(/rate limit/);
    expect(acl(BOB, payload()).accept).toBe(true);
    time += 60_001;
    expect(acl(ALICE, payload()).accept).toBe(true);
  });

  it('uses bounded safe defaults for invalid limit values', () => {
    const acl = buildChatAcl({
      config: {
        enabled: true,
        acl: { mode: 'trusted', peerAllowlist: [ALICE] },
        limits: { maxTextBytes: 0, maxMessagesPerMinute: -1 },
      },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(acl(ALICE, payload(undefined, DEFAULT_CHAT_MAX_TEXT_BYTES + 1)).accept).toBe(false);
    for (let i = 0; i < DEFAULT_CHAT_MAX_MESSAGES_PER_MINUTE; i += 1) {
      expect(acl(ALICE, payload()).accept).toBe(true);
    }
    expect(acl(ALICE, payload()).accept).toBe(false);
  });
});

describe('explicit legacy modes', () => {
  it('only opens mode=any when chat is explicitly enabled', () => {
    const acl = buildChatAcl({
      config: { enabled: true, acl: { mode: 'any' } },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(acl(ALICE, payload())).toEqual({ accept: true });
  });

  it('fail-closes an unknown mode', () => {
    const acl = buildChatAcl({
      config: { enabled: true, acl: { mode: 'typo' as never } },
      dashDb: db(),
      getLocalPeerId: () => LOCAL,
    });
    expect(acl(ALICE, payload()).reason).toMatch(/unknown ACL mode/);
  });
});
