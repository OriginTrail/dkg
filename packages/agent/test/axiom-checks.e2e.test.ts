/**
 * One test per V10 axiom. Real DKGAgent, Hardhat snapshot, no mocks — when
 * something regresses you get a concrete query/count failure, not a generic
 * "toThrow".
 *
 * Map (matches dkgv10-spec/02_AXIOMS.md):
 *   1. Context Graph isolation        -> "CG isolation..."
 *   2. Authority domain (WM)          -> "authority: spoofed callerAgentAddress..."
 *   3. Typed state transitions        -> "typed layers..."
 *   4. PUBLISH is canonical entry     -> "publish is what puts facts in VM..."
 *   5. SWM is staging, not truth      -> "SWM is staging only..."
 *   6. Get resolves a declared view   -> "each GET view returns its layer only"
 *   7. Deterministic conflict rules   -> "two publishers same root entity..."
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const PEER_A = '12D3KooWAxiomPeerA0000000000000000000000000000000000';
const PEER_B = '12D3KooWAxiomPeerB1111111111111111111111111111111111';
const P_NAME = 'http://schema.org/name';
const P_DESC = 'http://schema.org/description';

let snap: string;
let agent: DKGAgent;
let bAddr: string;

function freshCg(label: string) {
  return `${label}-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
}

function urn(tag: string) {
  return `urn:axiom:${tag}:${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
}

function subjects(r: { bindings: { s?: string }[] }) {
  return new Set(r.bindings.map((b) => b.s).filter(Boolean) as string[]);
}

beforeAll(async () => {
  snap = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const w = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, w.address, ethers.parseEther('1000000'));

  agent = await DKGAgent.create({
    name: 'AxiomSuite',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await agent.start();
  bAddr = (await agent.registerAgent('B')).agentAddress;
});

afterAll(async () => {
  try {
    await agent.stop();
  } catch {
    /* tear-down best effort */
  }
  await revertSnapshot(snap);
});

describe('V10 axioms (agent)', () => {
  it('CG isolation: same subject IRI in two graphs keeps separate values', async () => {
    const left = freshCg('cg-a');
    const right = freshCg('cg-b');
    const s = urn('shared');
    await agent.createContextGraph({ id: left, name: 'a', description: '' });
    await agent.createContextGraph({ id: right, name: 'b', description: '' });

    const row = (v: string) => ({ subject: s, predicate: P_NAME, object: `"${v}"`, graph: '' });
    await agent.share(left, [row('alpha')], { localOnly: true });
    await agent.share(right, [row('beta')], { localOnly: true });

    const q = (cg: string) =>
      agent.query(`SELECT ?o WHERE { <${s}> <${P_NAME}> ?o }`, {
        contextGraphId: cg,
        view: 'shared-working-memory',
      });

    const a = await q(left);
    const b = await q(right);
    expect(a.bindings).toHaveLength(1);
    expect(b.bindings).toHaveLength(1);
    expect(a.bindings[0]?.o).toBe('"alpha"');
    expect(b.bindings[0]?.o).toBe('"beta"');
  }, 30_000);

  it('authority: spoofed callerAgentAddress cannot read peer WM', async () => {
    const cg = freshCg('auth');
    const secret = urn('wm');
    const own = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({ id: cg, name: 'auth', description: '' });
    await agent.assertion.create(cg, 'slot');
    await agent.assertion.write(cg, 'slot', [{ subject: secret, predicate: P_DESC, object: '"mine"', graph: '' }]);

    const opts = (caller: string) => ({
      contextGraphId: cg,
      view: 'working-memory' as const,
      agentAddress: own,
      callerAgentAddress: caller,
    });

    const blocked = await agent.query(`SELECT ?o WHERE { <${secret}> <${P_DESC}> ?o }`, opts(bAddr));
    const ok = await agent.query(`SELECT ?o WHERE { <${secret}> <${P_DESC}> ?o }`, opts(own));

    expect(blocked.bindings).toHaveLength(0);
    expect(ok.bindings[0]?.o).toBe('"mine"');
  }, 30_000);

  it('typed layers: WM → promote → publish lands in VM (no VM before publish)', async () => {
    const cg = freshCg('layers');
    const sub = urn('flow');
    await agent.createContextGraph({ id: cg, name: 'layers', description: '' });
    await agent.registerContextGraph(cg);
    await agent.assertion.create(cg, 'chat');
    await agent.assertion.write(cg, 'chat', [{ subject: sub, predicate: P_NAME, object: '"v1"', graph: '' }]);

    expect(
      (await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, { contextGraphId: cg, view: 'verified-memory' }))
        .bindings,
    ).toHaveLength(0);

    await agent.assertion.promote(cg, 'chat');
    expect(
      (await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, { contextGraphId: cg, view: 'shared-working-memory' }))
        .bindings,
    ).toHaveLength(1);

    const out = await agent.publishFromSharedMemory(cg, 'all');
    expect(out.status).toBe('confirmed');

    const vm = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'verified-memory',
    });
    expect(vm.bindings[0]?.o).toBe('"v1"');
  }, 40_000);

  it('publish is what puts facts in verified-memory (share alone is not enough)', async () => {
    const cg = freshCg('pub');
    const sub = urn('ka');
    await agent.createContextGraph({ id: cg, name: 'pub', description: '' });
    await agent.registerContextGraph(cg);
    await agent.share(cg, [{ subject: sub, predicate: P_NAME, object: '"staged"', graph: '' }], { localOnly: true });

    expect(
      (await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, { contextGraphId: cg, view: 'verified-memory' }))
        .bindings,
    ).toHaveLength(0);

    const pub = await agent.publishFromSharedMemory(cg, { rootEntities: [sub] });
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toContain('did:dkg:evm:31337/');

    const vm = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'verified-memory',
    });
    expect(vm.bindings[0]?.o).toBe('"staged"');
  }, 40_000);

  it('SWM is staging only until publish clears it', async () => {
    const cg = freshCg('stage');
    const sub = urn('stage');
    await agent.createContextGraph({ id: cg, name: 'stage', description: '' });
    await agent.registerContextGraph(cg);
    await agent.share(cg, [{ subject: sub, predicate: P_NAME, object: '"wip"', graph: '' }], { localOnly: true });

    const swm = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'shared-working-memory',
    });
    const vm0 = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'verified-memory',
    });
    expect(swm.bindings).toHaveLength(1);
    expect(vm0.bindings).toHaveLength(0);

    await agent.publishFromSharedMemory(cg, 'all', { clearSharedMemoryAfter: true });

    const swmAfter = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'shared-working-memory',
    });
    const vmAfter = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'verified-memory',
    });
    expect(swmAfter.bindings).toHaveLength(0);
    expect(vmAfter.bindings).toHaveLength(1);
  }, 40_000);

  it('each GET view returns its layer only', async () => {
    const cg = freshCg('views');
    const [wSub, sSub, vSub] = [urn('w'), urn('s'), urn('v')];
    await agent.createContextGraph({ id: cg, name: 'views', description: '' });
    await agent.registerContextGraph(cg);

    await agent.assertion.create(cg, 'wm');
    await agent.assertion.write(cg, 'wm', [{ subject: wSub, predicate: P_NAME, object: '"w"', graph: '' }]);
    await agent.share(cg, [{ subject: sSub, predicate: P_NAME, object: '"s"', graph: '' }], { localOnly: true });
    await agent.publish(cg, [{ subject: vSub, predicate: P_NAME, object: '"v"', graph: '' }]);

    const addr = agent.getDefaultAgentAddress()!;
    const sel = `SELECT ?s WHERE { ?s <${P_NAME}> ?o }`;

    const wm = await agent.query(sel, { contextGraphId: cg, view: 'working-memory', agentAddress: addr });
    const swm = await agent.query(sel, { contextGraphId: cg, view: 'shared-working-memory' });
    const vm = await agent.query(sel, { contextGraphId: cg, view: 'verified-memory' });

    expect(subjects(wm)).toEqual(new Set([wSub]));
    expect(subjects(swm)).toEqual(new Set([sSub]));
    expect(subjects(vm)).toEqual(new Set([vSub]));
  }, 40_000);

  it('two publishers same root entity: one succeeds, one Rule 4 rejection', async () => {
    const cg = freshCg('race');
    const sub = urn('race');
    await agent.createContextGraph({ id: cg, name: 'race', description: '' });

    const shareAs = (peer: string, literal: string) =>
      agent.publisher.share(cg, [{ subject: sub, predicate: P_NAME, object: `"${literal}"`, graph: '' }], {
        publisherPeerId: peer,
      });

    const outcome = await Promise.allSettled([shareAs(PEER_A, 'a'), shareAs(PEER_B, 'b')]);
    const ok = outcome.filter((x) => x.status === 'fulfilled');
    const bad = outcome.filter((x) => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);

    const err = (bad[0] as PromiseRejectedResult).reason as Error;
    expect(err.message).toMatch(/Rule 4|already exists|SWM_ENTITY_OWNED/i);

    const row = await agent.query(`SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`, {
      contextGraphId: cg,
      view: 'shared-working-memory',
    });
    expect(row.bindings).toHaveLength(1);
    expect(['"a"', '"b"']).toContain(row.bindings[0]?.o);
  }, 40_000);
});
