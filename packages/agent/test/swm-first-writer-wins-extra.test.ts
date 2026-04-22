/**
 * SWM first-writer-wins — two peers racing to write the same rootEntity.
 *
 * Audit findings covered:
 *   A-3 (CRITICAL) — per dkgv10-spec §04_MEMORY_MODEL and
 *        03_PROTOCOL_CORE §8.2 (conflict handling), the first peer to
 *        write a given rootEntity into the SWM of a Context Graph wins.
 *        A later write from a DIFFERENT peer for the SAME rootEntity MUST
 *        be rejected with a soft-lock error (the spec's SWM_ENTITY_OWNED
 *        rejection). The same peer may re-write its OWN entity — that's
 *        a normal upsert path.
 *
 *        Enforcement lives in `DKGPublisher._shareImpl` (validation Rule 4
 *        `Entity exclusivity`) backed by the in-memory
 *        `sharedMemoryOwnedEntities` map. This file pins:
 *
 *          1. Happy path: first writer creates, subsequent same-peer
 *             re-writes upsert cleanly.
 *          2. Conflict: a second peer writing the SAME rootEntity is
 *             rejected with a "Rule 4 / already exists" error — the
 *             SWM_ENTITY_OWNED soft-lock.
 *          3. Stress: under concurrent `Promise.all([A.share, B.share])`
 *             exactly ONE call resolves and the other rejects — no
 *             silent tie (both succeed) and no silent loss (both fail).
 *
 * No mocks — uses the real `DKGAgent#publisher` API directly, with two
 * synthetic publisherPeerIds to simulate the "two peers, one CG" scenario
 * on a single publisher instance (which is the enforcement boundary).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const PEER_A = '12D3KooWPeerA00000000000000000000000000000000000000';
const PEER_B = '12D3KooWPeerB11111111111111111111111111111111111111';

function cgId(prefix: string): string {
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
    name: 'A3FirstWriter',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await node.start();
});

afterAll(async () => {
  try { await node?.stop(); } catch { /* */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-3: SWM first-writer-wins (Rule 4 / SWM_ENTITY_OWNED)', () => {
  it('first writer creates; same peer can re-write (upsert)', async () => {
    const contextGraphId = cgId('fww-upsert');
    const entity = `urn:a3:upsert:${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
    await node!.createContextGraph({ id: contextGraphId, name: 'FWW Upsert', description: '' });

    const q1 = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"v1"', graph: '' },
    ];
    const first = await node!.publisher.share(contextGraphId, q1, {
      publisherPeerId: PEER_A,
    });
    expect(first.shareOperationId).toMatch(/.+/);

    // Re-write by the SAME peer — upsert path, must succeed.
    const q2 = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"v2"', graph: '' },
    ];
    const second = await node!.publisher.share(contextGraphId, q2, {
      publisherPeerId: PEER_A,
    });
    expect(second.shareOperationId).toMatch(/.+/);
  });

  it('second peer writing same rootEntity is REJECTED with a Rule 4 soft-lock error', async () => {
    const contextGraphId = cgId('fww-conflict');
    const entity = `urn:a3:conflict:${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
    await node!.createContextGraph({ id: contextGraphId, name: 'FWW Conflict', description: '' });

    // A wins.
    await node!.publisher.share(contextGraphId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"from-A"', graph: '' },
    ], { publisherPeerId: PEER_A });

    // B attempts the same rootEntity — must be rejected.
    let caught: Error | null = null;
    try {
      await node!.publisher.share(contextGraphId, [
        { subject: entity, predicate: 'http://schema.org/name', object: '"from-B"', graph: '' },
      ], { publisherPeerId: PEER_B });
    } catch (e) {
      caught = e as Error;
    }
    expect(
      caught,
      'second peer writing same entity should be rejected by Rule 4 / SWM_ENTITY_OWNED',
    ).not.toBeNull();
    expect(caught!.message).toMatch(/Rule 4|already exists|SWM_ENTITY_OWNED/i);

    // And the SWM must still carry A's value — B must not have overwritten.
    const qr = await node!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId, view: 'shared-working-memory' },
    );
    expect(qr.bindings.length).toBe(1);
    expect(qr.bindings[0]['o']).toBe('"from-A"');
  });

  it('concurrent race: exactly ONE of two peers wins, the other gets a rejection', async () => {
    const contextGraphId = cgId('fww-race');
    const entity = `urn:a3:race:${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
    await node!.createContextGraph({ id: contextGraphId, name: 'FWW Race', description: '' });

    const shareFrom = (peer: string, tag: string) => node!.publisher.share(
      contextGraphId,
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${tag}"`, graph: '' }],
      { publisherPeerId: peer },
    );

    const results = await Promise.allSettled([
      shareFrom(PEER_A, 'A-wins'),
      shareFrom(PEER_B, 'B-wins'),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(
      fulfilled.length,
      'exactly one concurrent writer must win — both resolved would be a double-commit (A-3 violation)',
    ).toBe(1);
    expect(
      rejected.length,
      'exactly one concurrent writer must be rejected — both rejected is a liveness failure',
    ).toBe(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason.message).toMatch(/Rule 4|already exists|SWM_ENTITY_OWNED/i);
  });

  it('different rootEntity on same CG: two peers coexist (no false positive lock)', async () => {
    const contextGraphId = cgId('fww-indep');
    await node!.createContextGraph({ id: contextGraphId, name: 'FWW Indep', description: '' });

    const entityA = `urn:a3:indep:A-${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
    const entityB = `urn:a3:indep:B-${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;

    await node!.publisher.share(contextGraphId, [
      { subject: entityA, predicate: 'http://schema.org/name', object: '"A-data"', graph: '' },
    ], { publisherPeerId: PEER_A });

    await node!.publisher.share(contextGraphId, [
      { subject: entityB, predicate: 'http://schema.org/name', object: '"B-data"', graph: '' },
    ], { publisherPeerId: PEER_B });

    const qr = await node!.query(
      `SELECT ?s ?o WHERE { ?s <http://schema.org/name> ?o } ORDER BY ?s`,
      { contextGraphId, view: 'shared-working-memory' },
    );
    const map = new Map(qr.bindings.map(b => [b['s'], b['o']]));
    expect(map.get(entityA)).toBe('"A-data"');
    expect(map.get(entityB)).toBe('"B-data"');
  });
});
