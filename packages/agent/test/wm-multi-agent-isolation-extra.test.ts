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
  });
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
    // leakage). Tracks BUGS_FOUND.md A-1.
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
