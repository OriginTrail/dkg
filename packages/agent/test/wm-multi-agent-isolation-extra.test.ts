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
 *         `agentAddress: A.address, view: 'working-memory'` in `query()`.
 *         Per spec §04 and RFC-29 this MUST be rejected — the agent layer
 *         has no per-request agent authentication, so this test documents
 *         the current behaviour: the data is returned. PROD-BUG surface.
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

  it('PROD-BUG: query(view:"working-memory", agentAddress: OTHER) returns the other agent\'s WM with no authn check', async () => {
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

    // B supplies A's address in the query options — the agent layer has
    // no per-request authentication, so this impersonation currently
    // succeeds. Per spec §04 and RFC-29 this should return 0 bindings
    // (cross-agent WM read denied). See BUGS_FOUND.md A-1.
    const defaultA = node!.getDefaultAgentAddress()!;
    const leak = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/description> ?o }`,
      {
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultA, // impersonation
      },
    );

    // PROD-BUG: this expectation pins the spec. With no authn gate in
    // `DKGAgent#query`, the current implementation returns A's secret to
    // any caller that guesses/knows A's address. Expected to go RED.
    expect(
      leak.bindings.length,
      'cross-agent WM access (spec §04/RFC-29 violation) — BUGS_FOUND.md A-1',
    ).toBe(0);
  });

  it('assertion graph URI encodes the agentAddress (structural isolation invariant)', () => {
    const cgId = 'structural-check';
    const a = contextGraphAssertionUri(cgId, '0x1111111111111111111111111111111111111111', 'chat');
    const b = contextGraphAssertionUri(cgId, '0x2222222222222222222222222222222222222222', 'chat');
    expect(a).not.toBe(b);
    expect(a).toContain('0x1111111111111111111111111111111111111111');
    expect(b).toContain('0x2222222222222222222222222222222222222222');
  });
});
