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

let _fileSnapshot: string;
let node: DKGAgent | undefined;
let agentBAddress = '';

const PEER_A = '12D3KooWAxiomPeerA0000000000000000000000000000000000';
const PEER_B = '12D3KooWAxiomPeerB1111111111111111111111111111111111';

function cgId(prefix: string): string {
  return `${prefix}-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
}

function entity(prefix: string): string {
  return `urn:axiom:${prefix}:${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
}

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('1000000'));

  node = await DKGAgent.create({
    name: 'AxiomChecksNode',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await node.start();
  const regB = await node.registerAgent('AxiomAgentB');
  agentBAddress = regB.agentAddress;
});

afterAll(async () => {
  try { await node?.stop(); } catch { /* noop */ }
  await revertSnapshot(_fileSnapshot);
});

describe('Axiom checks (V10)', () => {
  it('Axiom 1: context graphs remain isolated knowledge boundaries', async () => {
    const cgA = cgId('ax1-a');
    const cgB = cgId('ax1-b');
    const sharedEntity = entity('same-subject');
    await node!.createContextGraph({ id: cgA, name: 'Axiom1 A', description: '' });
    await node!.createContextGraph({ id: cgB, name: 'Axiom1 B', description: '' });

    await node!.share(cgA, [{ subject: sharedEntity, predicate: 'http://schema.org/name', object: '"A-value"', graph: '' }], { localOnly: true });
    await node!.share(cgB, [{ subject: sharedEntity, predicate: 'http://schema.org/name', object: '"B-value"', graph: '' }], { localOnly: true });

    const inA = await node!.query(
      `SELECT ?o WHERE { <${sharedEntity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgA, view: 'shared-working-memory' },
    );
    const inB = await node!.query(
      `SELECT ?o WHERE { <${sharedEntity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgB, view: 'shared-working-memory' },
    );
    expect(inA.bindings).toHaveLength(1);
    expect(inB.bindings).toHaveLength(1);
    expect(inA.bindings[0]['o']).toBe('"A-value"');
    expect(inB.bindings[0]['o']).toBe('"B-value"');
  }, 30_000);

  it('Axiom 2: protected scope authority denies cross-agent WM reads', async () => {
    const cg = cgId('ax2');
    const secret = entity('authority');
    const agentA = node!.getDefaultAgentAddress()!;
    await node!.createContextGraph({ id: cg, name: 'Axiom2', description: '' });
    await node!.assertion.create(cg, 'wm-secret');
    await node!.assertion.write(cg, 'wm-secret', [{
      subject: secret,
      predicate: 'http://schema.org/description',
      object: '"A-only"',
      graph: '',
    }]);

    const denied = await node!.query(
      `SELECT ?o WHERE { <${secret}> <http://schema.org/description> ?o }`,
      {
        contextGraphId: cg,
        view: 'working-memory',
        agentAddress: agentA,
        callerAgentAddress: agentBAddress,
      },
    );
    const allowed = await node!.query(
      `SELECT ?o WHERE { <${secret}> <http://schema.org/description> ?o }`,
      {
        contextGraphId: cg,
        view: 'working-memory',
        agentAddress: agentA,
        callerAgentAddress: agentA,
      },
    );
    expect(denied.bindings.length).toBe(0);
    expect(allowed.bindings.length).toBe(1);
    expect(allowed.bindings[0]['o']).toBe('"A-only"');
  }, 30_000);

  it('Axiom 3: state progresses only through typed WM->SWM->VM transitions', async () => {
    const cg = cgId('ax3');
    const subject = entity('typed-transition');
    await node!.createContextGraph({ id: cg, name: 'Axiom3', description: '' });
    await node!.registerContextGraph(cg);
    await node!.assertion.create(cg, 'typed-flow');
    await node!.assertion.write(cg, 'typed-flow', [{ subject, predicate: 'http://schema.org/name', object: '"draft-v1"', graph: '' }]);

    const vmBefore = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(vmBefore.bindings.length).toBe(0);
    await node!.assertion.promote(cg, 'typed-flow');
    const swmAfterPromote = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'shared-working-memory' },
    );
    expect(swmAfterPromote.bindings.length).toBe(1);

    const result = await node!.publishFromSharedMemory(cg, 'all');
    const vmAfterPublish = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(result.status).toBe('confirmed');
    expect(vmAfterPublish.bindings.length).toBe(1);
    expect(vmAfterPublish.bindings[0]['o']).toBe('"draft-v1"');
  }, 40_000);

  it('Axiom 4: only PUBLISH introduces authoritative verified-memory state', async () => {
    const cg = cgId('ax4');
    const subject = entity('publish-entry');
    await node!.createContextGraph({ id: cg, name: 'Axiom4', description: '' });
    await node!.registerContextGraph(cg);
    await node!.share(cg, [{ subject, predicate: 'http://schema.org/name', object: '"candidate"', graph: '' }], { localOnly: true });

    const vmBefore = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(vmBefore.bindings.length).toBe(0);
    const pub = await node!.publishFromSharedMemory(cg, { rootEntities: [subject] });
    const vmAfter = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(vmAfter.bindings.length).toBe(1);
    expect(vmAfter.bindings[0]['o']).toBe('"candidate"');
  }, 40_000);

  it('Axiom 5: shared working memory stays provisional until publish finalizes it', async () => {
    const cg = cgId('ax5');
    const subject = entity('provisional');
    await node!.createContextGraph({ id: cg, name: 'Axiom5', description: '' });
    await node!.registerContextGraph(cg);
    await node!.share(cg, [{ subject, predicate: 'http://schema.org/name', object: '"in-staging"', graph: '' }], { localOnly: true });

    const swmBefore = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'shared-working-memory' },
    );
    const vmBefore = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(swmBefore.bindings.length).toBe(1);
    expect(vmBefore.bindings.length).toBe(0);

    await node!.publishFromSharedMemory(cg, 'all', { clearSharedMemoryAfter: true });
    const swmAfter = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'shared-working-memory' },
    );
    const vmAfter = await node!.query(
      `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(swmAfter.bindings.length).toBe(0);
    expect(vmAfter.bindings.length).toBe(1);
  }, 40_000);

  it('Axiom 6: GET resolves explicit views without mixing memory layers', async () => {
    const cg = cgId('ax6');
    const wmEntity = entity('wm');
    const swmEntity = entity('swm');
    const vmEntity = entity('vm');
    await node!.createContextGraph({ id: cg, name: 'Axiom6', description: '' });
    await node!.registerContextGraph(cg);
    await node!.assertion.create(cg, 'views');
    await node!.assertion.write(cg, 'views', [{ subject: wmEntity, predicate: 'http://schema.org/name', object: '"wm-value"', graph: '' }]);
    await node!.share(cg, [{ subject: swmEntity, predicate: 'http://schema.org/name', object: '"swm-value"', graph: '' }], { localOnly: true });
    await node!.publish(cg, [{ subject: vmEntity, predicate: 'http://schema.org/name', object: '"vm-value"', graph: '' }]);

    const wmView = await node!.query(
      `SELECT ?s WHERE { ?s <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'working-memory', agentAddress: node!.getDefaultAgentAddress()! },
    );
    const swmView = await node!.query(
      `SELECT ?s WHERE { ?s <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'shared-working-memory' },
    );
    const vmView = await node!.query(
      `SELECT ?s WHERE { ?s <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(new Set(wmView.bindings.map((b) => b['s']))).toEqual(new Set([wmEntity]));
    expect(new Set(swmView.bindings.map((b) => b['s']))).toEqual(new Set([swmEntity]));
    expect(new Set(vmView.bindings.map((b) => b['s']))).toEqual(new Set([vmEntity]));
  }, 40_000);

  it('Axiom 7: conflicts resolve deterministically (single winner, single rejection)', async () => {
    const cg = cgId('ax7');
    const contested = entity('conflict');
    await node!.createContextGraph({ id: cg, name: 'Axiom7', description: '' });
    const race = await Promise.allSettled([
      node!.publisher.share(cg, [{ subject: contested, predicate: 'http://schema.org/name', object: '"from-peer-a"', graph: '' }], { publisherPeerId: PEER_A }),
      node!.publisher.share(cg, [{ subject: contested, predicate: 'http://schema.org/name', object: '"from-peer-b"', graph: '' }], { publisherPeerId: PEER_B }),
    ]);

    const winners = race.filter((r) => r.status === 'fulfilled');
    const losers = race.filter((r) => r.status === 'rejected');
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    const reason = (losers[0] as PromiseRejectedResult).reason as Error;
    expect(reason.message).toMatch(/Rule 4|already exists|SWM_ENTITY_OWNED/i);
    const swm = await node!.query(
      `SELECT ?o WHERE { <${contested}> <http://schema.org/name> ?o }`,
      { contextGraphId: cg, view: 'shared-working-memory' },
    );
    expect(swm.bindings.length).toBe(1);
  }, 40_000);
});
