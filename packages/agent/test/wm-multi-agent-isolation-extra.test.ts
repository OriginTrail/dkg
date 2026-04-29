/**
 * Multi-agent Working-Memory isolation on a single DKG node.
 *
 * Audit findings covered:
 *   A-1 (CRITICAL) — dkgv10-spec/rfcs/OT-RFC-29 and §04_MEMORY_MODEL.md
 *        say L0 (WM) is strictly per-agent: "One agent MUST NOT access
 *        another agent's L0." This file pins the isolation contract end
 *        to end using two real secp256k1 agent identities co-hosted on
 *        the same DKG node.
 *
 *   The test matrix:
 *     (a) Positive — A writes to its own WM, A reads from its own WM →
 *         data is visible.
 *     (b) Positive — A writes, B reads using B's own `agentAddress` →
 *         data is INVISIBLE. (graph-URI scoping holds.)
 *     (c) Isolation stress — B deliberately impersonates A by passing
 *         `agentAddress: A.address, view: 'working-memory'` in `query()`,
 *         while authenticated as B (the HTTP route plumbs the caller
 *         identity as `callerAgentAddress`). Per spec §04 and RFC-29
 *         this MUST be rejected — DKGAgent.query enforces the per-
 *         request agent authentication and returns 0 bindings.
 *
 *     (d) Hygiene — an attacker who gets a chat-name guess cannot read
 *         another agent's WM via `agent.assertion.query` because the bound
 *         `agentAddress` scopes the graph URI.
 *
 * No mocks — real DKGAgent, real wallets, real Hardhat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { contextGraphAssertionUri } from '@origintrail-official/dkg-core';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

let _fileSnapshot: string;
let node: DKGAgent | undefined;
let agentB: { agentAddress: string };

function freshCgId(prefix: string): string {
  return `${prefix}-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
}

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('1000000'),
  );

  node = await DKGAgent.create({
    name: 'WmIsolationNode',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
    // strict WM cross-agent auth is now
    // the DEFAULT (fail-closed). Passing `true` here is redundant but
    // kept for readability — the matrix below assumes strict mode and
    // adding the flag makes the intent obvious even if the default
    // later regresses.
    strictWmCrossAgentAuth: true,
  } as any);
  await node.start();

  // Register a second agent "B" co-hosted on the same node. The default
  // agent (auto-registered at start) is "A".
  const regB = await node.registerAgent('AgentB');
  agentB = { agentAddress: regB.agentAddress };
});

afterAll(async () => {
  try { await node?.stop(); } catch { /* */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-1: WM is per-agent — two agents co-hosted on one node', () => {
  it('two distinct agent identities are registered with different addresses', () => {
    const defaultA = node!.getDefaultAgentAddress();
    expect(defaultA).toBeDefined();
    expect(defaultA).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(agentB.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(defaultA!.toLowerCase()).not.toBe(agentB.agentAddress.toLowerCase());
    const all = node!.listLocalAgents().map(r => r.agentAddress.toLowerCase());
    expect(all).toContain(defaultA!.toLowerCase());
    expect(all).toContain(agentB.agentAddress.toLowerCase());
  });

  it('A can read its own WM after writing', async () => {
    const cgId = freshCgId('wm-iso-a');
    await node!.createContextGraph({ id: cgId, name: 'WM Iso A', description: '' });

    await node!.assertion.create(cgId, 'chat-a');
    await node!.assertion.write(cgId, 'chat-a', [
      {
        subject: 'urn:wm:alice:fact:secret',
        predicate: 'http://schema.org/description',
        object: '"A-only private note"',
        graph: '',
      },
    ]);

    const quads = await node!.assertion.query(cgId, 'chat-a');
    expect(quads.length).toBe(1);
    expect(quads[0].subject).toBe('urn:wm:alice:fact:secret');
    expect(quads[0].object).toBe('"A-only private note"');
  });

  it('B cannot accidentally see A\'s WM via its OWN agentAddress (graph-URI scoping holds)', async () => {
    const cgId = freshCgId('wm-iso-b');
    await node!.createContextGraph({ id: cgId, name: 'WM Iso B', description: '' });

    // A writes under A's address.
    const defaultA = node!.getDefaultAgentAddress()!;
    await node!.assertion.create(cgId, 'private-diary');
    await node!.assertion.write(cgId, 'private-diary', [
      {
        subject: 'urn:wm:alice:fact:top-secret',
        predicate: 'http://schema.org/description',
        object: '"Only A should see this"',
        graph: '',
      },
    ]);

    // B issues a WM-view query with B's own agentAddress. The WM graph URI
    // for B is distinct from A's → nothing should come back.
    const bQuery = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: agentB.agentAddress,
      },
    );
    expect(
      bQuery.bindings.length,
      'B must not see A-scoped WM quads through B-scoped WM view',
    ).toBe(0);

    // And the A-scoped WM URI must be structurally different from B's.
    const aWmUri = contextGraphAssertionUri(cgId, defaultA, 'private-diary');
    const bWmUri = contextGraphAssertionUri(cgId, agentB.agentAddress, 'private-diary');
    expect(aWmUri).not.toBe(bWmUri);
  });

  it('A-1: authenticated cross-agent WM read is denied (caller=B cannot read agentAddress=A)', async () => {
    const cgId = freshCgId('wm-iso-c');
    await node!.createContextGraph({ id: cgId, name: 'WM Iso C', description: '' });

    await node!.assertion.create(cgId, 'boardroom');
    await node!.assertion.write(cgId, 'boardroom', [
      {
        subject: 'urn:wm:alice:leak',
        predicate: 'http://schema.org/description',
        object: '"Merger details — A-only"',
        graph: '',
      },
    ]);

    // B supplies A's address in the query options while authenticated
    // as B. The HTTP route plumbs the caller identity through
    // `callerAgentAddress` — see packages/cli/src/daemon.ts /api/query.
    // Per spec §04 and RFC-29 this impersonation attempt MUST be
    // denied at the DKGAgent.query boundary (0 bindings, no data
    // leakage). Tracks.
    const defaultA = node!.getDefaultAgentAddress()!;
    const leak = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA, // impersonation: target A's WM graph
        callerAgentAddress: agentB.agentAddress, // authenticated as B
      },
    );

    expect(
      leak.bindings.length,
      'cross-agent WM access must be denied when callerAgentAddress mismatches agentAddress (A-1)',
    ).toBe(0);
  });

  it('A-1: same-agent authenticated WM read still works (caller=A reads agentAddress=A)', async () => {
    const cgId = freshCgId('wm-iso-c2');
    await node!.createContextGraph({ id: cgId, name: 'WM Iso C2', description: '' });

    await node!.assertion.create(cgId, 'journal');
    await node!.assertion.write(cgId, 'journal', [
      {
        subject: 'urn:wm:alice:own-note',
        predicate: 'http://schema.org/description',
        object: '"A reads A"',
        graph: '',
      },
    ]);

    const defaultA = node!.getDefaultAgentAddress()!;
    const own = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
        callerAgentAddress: defaultA, // authenticated as A, targeting A's WM
      },
    );
    expect(own.bindings.length).toBe(1);
  });

  it(
    'A-1 (Codex PR #242 iter-8): omitted agentAddress on an authenticated WM read defaults ' +
      'to callerAgentAddress — an agent-bound caller cannot escape isolation by just not ' +
      'supplying agentAddress and falling through to the node-default peerId WM.',
    async () => {
      const cgId = freshCgId('wm-iso-omit');
      await node!.createContextGraph({ id: cgId, name: 'WM Iso omit', description: '' });

      // Seed B's WM directly via the publisher API (agent.assertion
      // captures the default agent's address in a closure, so we
      // bypass it to write as B).
      const assertionName = 'b-secret';
      await node!.publisher.assertionCreate(cgId, assertionName, agentB.agentAddress);
      await node!.publisher.assertionWrite(cgId, assertionName, agentB.agentAddress, [
        {
          subject: 'urn:wm:bob:only',
          predicate: 'http://schema.org/description',
          object: '"B-private"',
          graph: '',
        },
      ]);

      // B authenticates (callerAgentAddress=B) but OMITS agentAddress.
      // Previously this silently fell through to the `peerId` (node
      // default) namespace, leaking a different agent's WM to B. With
      // the omission-default fix, the query must resolve B's own WM.
      const resB = await node!.query(
        `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
        {
          contextGraphId: cgId,
          view: 'working-memory',
          callerAgentAddress: agentB.agentAddress,
          // agentAddress intentionally omitted
        },
      );
      expect(resB.bindings.length).toBe(1);
    },
  );

  it(
    'A-1 (Codex PR #242 iter-9 re-review): default-agent self-reads via peerId alias ' +
      'must resolve to the same canonical identity. Legacy WM callers ' +
      '(ChatMemoryManager, SKILL.md examples) use `agentAddress=<peerId>` — an ' +
      'agent-scoped token whose callerAgentAddress is the default agent\'s EVM ' +
      'address must be able to read that legacy namespace without falling into ' +
      "the A-1 mismatch deny branch.",
    async () => {
      const cgId = freshCgId('wm-iso-peerid');
      await node!.createContextGraph({ id: cgId, name: 'WM Iso peerId', description: '' });

      const defaultA = node!.getDefaultAgentAddress()!;
      const peerId = node!.peerId;
      expect(
        peerId,
        'this test needs the node to expose a peerId — otherwise the ' +
          'alias case we are pinning does not exist',
      ).toBeTruthy();

      // Seed the legacy peerId-keyed WM namespace for the default
      // agent (this is the path ChatMemoryManager still writes to).
      const assertionName = 'legacy-peerid-wm';
      await node!.publisher.assertionCreate(cgId, assertionName, peerId!);
      await node!.publisher.assertionWrite(cgId, assertionName, peerId!, [
        {
          subject: 'urn:wm:legacy:peerid-note',
          predicate: 'http://schema.org/description',
          object: '"legacy peerId-keyed WM"',
          graph: '',
        },
      ]);

      // Authenticated as the default agent (EVM), read with the
      // peerId alias. Pre-iter-9 this fell into
      // `callerAddr.toLowerCase() !== targetAddr.toLowerCase()` and
      // returned 0 bindings even though both identifiers point at
      // the same identity.
      const viaPeerId = await node!.query(
        `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
        {
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: peerId!,
          callerAgentAddress: defaultA,
        },
      );
      expect(
        viaPeerId.bindings.length,
        'default-agent read with agentAddress=peerId must resolve to the same WM namespace',
      ).toBe(1);

      // And the omitted-agentAddress case: if the caller is the
      // default agent, the iter-9 default preserves legacy peerId
      // semantics so pre-existing peerId-keyed data stays
      // accessible.
      const viaOmit = await node!.query(
        `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
        {
          contextGraphId: cgId,
          view: 'working-memory',
          callerAgentAddress: defaultA,
          // agentAddress intentionally omitted
        },
      );
      expect(
        viaOmit.bindings.length,
        'default-agent omitted-agentAddress must default to peerId-keyed WM for legacy data access',
      ).toBe(1);
    },
  );

  it(
    'A-1 (Codex PR #242 iter-4): cross-agent WM mutation is REJECTED, not silently swallowed ' +
      'as a 0-binding deny. The access-denied fast-path used to return before ' +
      '`validateReadOnlySparql` ran, so `INSERT DATA { ... }` over another agent\'s WM ' +
      'would come back as an empty result (200 OK) instead of the 400 rejection ' +
      'that a SELECT cross-agent request would receive. This test pins the ' +
      'mutation path so the deny-shape and the guard-shape stay in sync.',
    async () => {
      const cgId = freshCgId('wm-iso-mutation');
      await node!.createContextGraph({ id: cgId, name: 'WM Iso mutation', description: '' });

      const defaultA = node!.getDefaultAgentAddress()!;
      await expect(
        node!.query(
          'INSERT DATA { GRAPH <urn:dkg:test> { <urn:s> <urn:p> "injected" } }',
          {
            contextGraphId: cgId,
            view: 'working-memory',
            agentAddress: defaultA,
            callerAgentAddress: agentB.agentAddress, // would-be impersonator
          },
        ),
      ).rejects.toThrow(/SPARQL rejected/);
    },
  );

  it('assertion graph URI encodes the agentAddress (structural isolation invariant)', () => {
    const cgId = 'structural-check';
    const a = contextGraphAssertionUri(cgId, '0x1111111111111111111111111111111111111111', 'chat');
    const b = contextGraphAssertionUri(cgId, '0x2222222222222222222222222222222222222222', 'chat');
    expect(a).not.toBe(b);
    expect(a).toContain('0x1111111111111111111111111111111111111111');
    expect(b).toContain('0x2222222222222222222222222222222222222222');
  });
});

// --------------------------------------------------------------------------
// `agentAuthSignature` must be bound to
// a freshness window AND a per-request nonce so a once-observed signature
// cannot be replayed forever. The previous challenge was the fixed string
// `dkg-wm-auth:<addr>`, which made every valid signature a permanent
// bearer credential for that address.
// --------------------------------------------------------------------------
describe('A-1 follow-up: WM-auth challenge is nonce/timestamp-bound (no permanent bearer)', () => {
  it('a freshly signed WM-auth token works exactly once and is rejected on replay', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;

    // Stage data in A's WM so the cross-agent query has something to find.
    const cgId = freshCgId('wm-replay');
    await node!.createContextGraph({ id: cgId, name: 'WM Replay', description: '' });
    await node!.assertion.create(cgId, 'replay');
    await node!.assertion.write(cgId, 'replay', [
      {
        subject: 'urn:wm:alice:fact:replay',
        predicate: 'http://schema.org/description',
        object: '"replay-probe"',
        graph: '',
      },
    ]);

    const token = node!.signWmAuthChallenge(defaultA);
    expect(token, 'a locally-registered agent can sign its challenge').toBeDefined();
    expect(token!.split('.').length).toBe(3);

    // First use: accepted — returns the staged quad.
    const first = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
        agentAuthSignature: token,
      },
    );
    expect(first.bindings.length).toBe(1);

    // Second use (replay): nonce has already been recorded — MUST be
    // rejected. With strictWmCrossAgentAuth on this fails closed and
    // returns zero bindings.
    const replay = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
        agentAuthSignature: token,
      },
    );
    expect(
      replay.bindings.length,
      'replayed WM-auth token must be rejected (strict mode)',
    ).toBe(0);
  });

  it('legacy fixed-string WM-auth signatures are rejected', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;

    // Stage a quad the test would be able to read if auth succeeded.
    const cgId = freshCgId('wm-legacy');
    await node!.createContextGraph({ id: cgId, name: 'WM Legacy', description: '' });
    await node!.assertion.create(cgId, 'legacy');
    await node!.assertion.write(cgId, 'legacy', [
      {
        subject: 'urn:wm:alice:fact:legacy',
        predicate: 'http://schema.org/description',
        object: '"legacy-probe"',
        graph: '',
      },
    ]);

    // Build a legacy v1 signature: sign the fixed string
    // `dkg-wm-auth:<addr>` directly, WITHOUT a timestamp or nonce.
    // Locate A's private key via the test harness' registered wallet.
    const agents = node!.listLocalAgents();
    const aRec = agents.find(a => a.agentAddress.toLowerCase() === defaultA.toLowerCase());
    expect(aRec).toBeDefined();
    // listLocalAgents strips privateKey — use the dev-only getter.
    const wallet = (node! as any).getLocalAgentWallet(defaultA);
    expect(wallet, 'test presumes local wallet is available for A').toBeDefined();
    const legacyMsg = `dkg-wm-auth:${defaultA.toLowerCase()}`;
    const legacySig = wallet!.signMessageSync(legacyMsg);

    const res = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
        agentAuthSignature: legacySig,
      },
    );
    expect(
      res.bindings.length,
      'legacy fixed-string (prefix-only) v1 WM-auth signature must be rejected',
    ).toBe(0);
  });

  it('stale WM-auth tokens (beyond freshness window) are rejected', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;

    // Forge a stale token: sign a challenge with a timestamp far in the past.
    const wallet = (node! as any).getLocalAgentWallet(defaultA);
    expect(wallet).toBeDefined();
    const staleTs = Date.now() - 5 * 60_000; // 5 min old
    const nonce = 'aa'.repeat(16); // 32-char hex, valid shape
    const msg = `dkg-wm-auth:v2:${defaultA.toLowerCase()}:${staleTs}:${nonce}`;
    const sig = wallet!.signMessageSync(msg);
    const staleToken = `${staleTs}.${nonce}.${sig}`;

    const cgId = freshCgId('wm-stale');
    await node!.createContextGraph({ id: cgId, name: 'WM Stale', description: '' });
    await node!.assertion.create(cgId, 'stale');
    await node!.assertion.write(cgId, 'stale', [
      {
        subject: 'urn:wm:alice:fact:stale',
        predicate: 'http://schema.org/description',
        object: '"stale-probe"',
        graph: '',
      },
    ]);

    const res = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
        agentAuthSignature: staleToken,
      },
    );
    expect(
      res.bindings.length,
      'stale WM-auth token (outside freshness window) must be rejected',
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // the gate defaults to
  // fail-closed. The three probes below flip `config.strictWmCrossAgentAuth`
  // and `process.env.DKG_STRICT_WM_AUTH` at runtime to exercise the
  // effective mode without spinning up a second heavyweight DKGAgent.
  // -------------------------------------------------------------------------
  it('default (no strictWmCrossAgentAuth set) is fail-closed — impersonation without signature returns 0', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const cgId = freshCgId('wm-default');
    await node!.createContextGraph({ id: cgId, name: 'WM Default', description: '' });
    await node!.assertion.create(cgId, 'd12');
    await node!.assertion.write(cgId, 'd12', [
      { subject: 'urn:wm:alice:fact:d12', predicate: 'http://schema.org/description', object: '"default-probe"', graph: '' },
    ]);

    const cfg = (node! as any).config as { strictWmCrossAgentAuth?: boolean };
    const prevCfg = cfg.strictWmCrossAgentAuth;
    const prevEnv = process.env.DKG_STRICT_WM_AUTH;
    cfg.strictWmCrossAgentAuth = undefined;
    delete process.env.DKG_STRICT_WM_AUTH;
    try {
      const res = await node!.query(
        `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
        { contextGraphId: cgId, view: 'working-memory', agentAddress: defaultA },
      );
      expect(
        res.bindings.length,
        'undefined config must default to fail-closed (r12-1)',
      ).toBe(0);
    } finally {
      cfg.strictWmCrossAgentAuth = prevCfg;
      if (prevEnv !== undefined) process.env.DKG_STRICT_WM_AUTH = prevEnv;
    }
  });

  it('explicit config opt-out (strictWmCrossAgentAuth=false) degrades to warn (impersonation succeeds)', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const cgId = freshCgId('wm-optout');
    await node!.createContextGraph({ id: cgId, name: 'WM Optout', description: '' });
    await node!.assertion.create(cgId, 'd12b');
    await node!.assertion.write(cgId, 'd12b', [
      { subject: 'urn:wm:alice:fact:d12b', predicate: 'http://schema.org/description', object: '"optout-probe"', graph: '' },
    ]);

    const cfg = (node! as any).config as { strictWmCrossAgentAuth?: boolean };
    const prevCfg = cfg.strictWmCrossAgentAuth;
    const prevEnv = process.env.DKG_STRICT_WM_AUTH;
    cfg.strictWmCrossAgentAuth = false;
    delete process.env.DKG_STRICT_WM_AUTH;
    try {
      const res = await node!.query(
        `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
        { contextGraphId: cgId, view: 'working-memory', agentAddress: defaultA },
      );
      expect(
        res.bindings.length,
        'explicit config=false must allow un-signed cross-agent reads (documents the legacy hole)',
      ).toBeGreaterThan(0);
    } finally {
      cfg.strictWmCrossAgentAuth = prevCfg;
      if (prevEnv !== undefined) process.env.DKG_STRICT_WM_AUTH = prevEnv;
    }
  });

  it('env opt-in (DKG_STRICT_WM_AUTH=1) overrides config=false — strict wins', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const cgId = freshCgId('wm-envwin');
    await node!.createContextGraph({ id: cgId, name: 'WM EnvWin', description: '' });
    await node!.assertion.create(cgId, 'd12c');
    await node!.assertion.write(cgId, 'd12c', [
      { subject: 'urn:wm:alice:fact:d12c', predicate: 'http://schema.org/description', object: '"envwin-probe"', graph: '' },
    ]);

    const cfg = (node! as any).config as { strictWmCrossAgentAuth?: boolean };
    const prevCfg = cfg.strictWmCrossAgentAuth;
    const prevEnv = process.env.DKG_STRICT_WM_AUTH;
    cfg.strictWmCrossAgentAuth = false;
    process.env.DKG_STRICT_WM_AUTH = '1';
    try {
      const res = await node!.query(
        `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
        { contextGraphId: cgId, view: 'working-memory', agentAddress: defaultA },
      );
      expect(
        res.bindings.length,
        'env opt-in must override config opt-out (fleet-wide tighten scenario)',
      ).toBe(0);
    } finally {
      cfg.strictWmCrossAgentAuth = prevCfg;
      if (prevEnv === undefined) delete process.env.DKG_STRICT_WM_AUTH;
      else process.env.DKG_STRICT_WM_AUTH = prevEnv;
    }
  });

  it('WM-auth tokens carrying a malformed nonce shape are rejected', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const wallet = (node! as any).getLocalAgentWallet(defaultA);
    expect(wallet).toBeDefined();

    // Malformed: non-hex nonce with obvious injection characters. The
    // verifier must reject this before reaching ethers.verifyMessage so
    // that a broken client cannot pollute the nonce cache with
    // arbitrary strings.
    const ts = Date.now();
    const badNonce = 'not-hex:@/bad';
    const msg = `dkg-wm-auth:v2:${defaultA.toLowerCase()}:${ts}:${badNonce}`;
    const sig = wallet!.signMessageSync(msg);
    const badToken = `${ts}.${badNonce}.${sig}`;

    const cgId = freshCgId('wm-malformed');
    await node!.createContextGraph({ id: cgId, name: 'WM Malformed', description: '' });
    await node!.assertion.create(cgId, 'malformed');
    await node!.assertion.write(cgId, 'malformed', [
      {
        subject: 'urn:wm:alice:fact:bad',
        predicate: 'http://schema.org/description',
        object: '"bad-probe"',
        graph: '',
      },
    ]);

    const res = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
        agentAuthSignature: badToken,
      },
    );
    expect(res.bindings.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // WM cross-agent deny paths must
  // preserve the *shape* the caller asked for. A `CONSTRUCT` caller branches
  // on `result.quads !== undefined` to decide whether it got graph data back;
  // returning `{ bindings: [] }` on a deny (as we did before r17-2) makes a
  // fail-closed denial look exactly like a legitimate SELECT-with-zero-rows
  // response, which is exactly the kind of silent shape-mismatch that
  // breaks downstream consumers in production. Pin the contract.
  // -------------------------------------------------------------------------
  it('CONSTRUCT deny on WM cross-agent impersonation returns quads:[] (shape preserved)', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const cgId = freshCgId('wm-r17-2-construct');
    await node!.createContextGraph({ id: cgId, name: 'WM r17-2 CONSTRUCT', description: '' });
    await node!.assertion.create(cgId, 'shape');
    await node!.assertion.write(cgId, 'shape', [
      {
        subject: 'urn:wm:alice:fact:shape',
        predicate: 'http://schema.org/description',
        object: '"r17-2-shape-probe"',
        graph: '',
      },
    ]);

    // Impersonation attempt from B → A's WM with no auth signature at all.
    // Strict mode is on (see beforeAll) so this MUST be denied.
    const res: any = await node!.query(
      `CONSTRUCT { ?s <http://schema.org/description> ?o } WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
      },
    );

    // The denial MUST:
    //  - return `quads` (the CONSTRUCT shape), not a bindings-only SELECT shape;
    //  - return an empty `quads` array (no data leaked);
    //  - return an empty `bindings` array alongside (stable `QueryResult` shape).
    expect(
      res.quads,
      'CONSTRUCT deny must preserve quads shape — otherwise callers branching on result.quads misread the deny as a SELECT',
    ).toBeDefined();
    expect(Array.isArray(res.quads)).toBe(true);
    expect(res.quads.length, 'denied CONSTRUCT must leak zero quads').toBe(0);
    expect(Array.isArray(res.bindings)).toBe(true);
    expect(res.bindings.length).toBe(0);
  });

  it('ASK deny on WM cross-agent impersonation returns bindings=[{result:"false"}]', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const cgId = freshCgId('wm-r17-2-ask');
    await node!.createContextGraph({ id: cgId, name: 'WM r17-2 ASK', description: '' });
    await node!.assertion.create(cgId, 'ask');
    await node!.assertion.write(cgId, 'ask', [
      {
        subject: 'urn:wm:alice:fact:ask',
        predicate: 'http://schema.org/description',
        object: '"r17-2-ask-probe"',
        graph: '',
      },
    ]);

    const res: any = await node!.query(
      `ASK { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
      },
    );

    // ASK deny must be the canonical "false" boolean — NOT an empty
    // bindings array (which would leak "true" to a caller that treats
    // `bindings.length === 0` as a failure signal).
    expect(Array.isArray(res.bindings)).toBe(true);
    expect(res.bindings.length).toBe(1);
    expect(res.bindings[0]?.result).toBe('false');
  });

  it('SELECT deny on WM cross-agent impersonation returns bindings=[] without a quads key', async () => {
    const defaultA = node!.getDefaultAgentAddress()!;
    const cgId = freshCgId('wm-r17-2-select');
    await node!.createContextGraph({ id: cgId, name: 'WM r17-2 SELECT', description: '' });
    await node!.assertion.create(cgId, 'sel');
    await node!.assertion.write(cgId, 'sel', [
      {
        subject: 'urn:wm:alice:fact:sel',
        predicate: 'http://schema.org/description',
        object: '"r17-2-sel-probe"',
        graph: '',
      },
    ]);

    const res: any = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA,
      },
    );

    expect(Array.isArray(res.bindings)).toBe(true);
    expect(res.bindings.length).toBe(0);
    // SELECT must NOT carry `quads` (that would hint at graph data and
    // confuse callers that normalize on `quads !== undefined`).
    expect(res.quads).toBeUndefined();
  });
});
