/**
 * Publish through the real pipeline against Hardhat and read it back.
 *
 * Audit finding A-4: publish real data via `DKGAgent#publish()`, then query
 * the `view:'verifiable-memory'` canonical graph and assert the published
 * data is observable. If the pipeline ever stops promoting confirmed data
 * into canonical, this catches it.
 *
 * No mocks: real store, real `DKGAgent`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
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
import { installHardhatACKProvider } from './_helpers/v10-acks.js';

let _fileSnapshot: string;
let nodeA: DKGAgent | undefined;

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('1000000'),
  );
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
    name: 'A4Promoter',
    listenPort: 0,
    skills: [],
    chainAdapter: chain,
    nodeRole: 'core',
  });
  await nodeA.start();
  await installHardhatACKProvider(nodeA, chain);
});

afterAll(async () => {
  try { await nodeA?.stop(); } catch { /* */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-4: e2e — agent.publish() data lands in canonical (data) view post-confirmation', () => {
  it('published data is observable via query(contextGraphId: cgId) AND via view=verifiable-memory on the publisher (RC11 / PR-A: Codex #671)', async () => {
    const cgId = `a4-e2e-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const entity = `urn:a4:e2e:${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;

    await nodeA!.createContextGraph({ id: cgId, name: 'A4 E2E', description: '' });
    await nodeA!.registerContextGraph(cgId);

    const pub = await nodeA!.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"E2E-A4"', graph: '' },
    ]);
    expect(pub.status, 'publish must confirm for the promotion invariant to apply').toBe('confirmed');

    // RC11 / PR2: the canonical data graph (`did:dkg:context-graph:{cg}`)
    // is populated AFTER on-chain confirmation now (not unconditionally
    // pre-chain). The original BUGS_FOUND.md A-4 invariant — "confirmed
    // publishes land where the publisher's own SPARQL can see them" —
    // is unchanged; we check it both via the default context-graph
    // scope AND via `view: 'verifiable-memory'` (RC11 / PR-A re-includes
    // the root data graph in VM so memory-search-style callers see
    // post-publish data immediately, without needing an explicit
    // `verify` step).
    const qr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      cgId,
    );
    expect(
      qr.bindings.length,
      'root context-graph must contain the published triple after confirmed publish (BUGS_FOUND.md A-4)',
    ).toBe(1);
    expect(qr.bindings[0]['o']).toBe('"E2E-A4"');

    // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
    // `view: 'verifiable-memory'` now unions the root context-graph with
    // `_verifiable_memory/{vmId}` sub-graphs, so a confirmed publish is
    // immediately observable via VM. The tentative-VM leak the PR2
    // first cut was guarding against is plugged at the publisher
    // (root-graph insert deferred to the chain-success branch), so
    // re-including root in VM no longer surfaces unconfirmed quads.
    const vmQr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'verifiable-memory' },
    );
    // GH #1264 promotion: a confirmed one-shot `publish()` now stores its public
    // data in BOTH the per-KA verifiable-memory graph (the publish write) AND the
    // scoped RS-prover graph `<cg>/context/<cgId>` (promoteConfirmedKCToScopedGraph).
    // The verifiable-memory read-both includes both (dkg-query-engine.ts
    // re-includes the per-cgId data graphs for #1098), but collapses an identical
    // full solution mapping already produced by an earlier mirror graph. The
    // canonical triple is therefore observed once without applying DISTINCT to
    // the caller projection (which would also erase legitimate bag multiplicity).
    expect(
      vmQr.bindings.length,
      'VM view deduplicates the identical per-KA VM + scoped #1264 mirror',
    ).toBe(1);
    expect(
      new Set(vmQr.bindings.map((b) => b['o'])),
      'every VM-view row must carry the published value (no wrong-member or stale row)',
    ).toEqual(new Set(['"E2E-A4"']));

    // And the same data MUST NOT remain in SWM post-confirmation —
    // leaving it there would be a double-counting leak.
    const swmQr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    expect(
      swmQr.bindings.length,
      'SWM must be cleared after confirmed publish — lingering quads indicate a failed promotion cleanup',
    ).toBe(0);
  });
});

describe('#774 F1: registerContextGraph access-policy mismatch is rejected (Codex review on #777)', () => {
  // Regression coverage for #774 finding #1. Before this fix, a CG
  // created public could be registered on-chain with `accessPolicy: 1`
  // (curated). The on-chain side ended up curated while the local
  // ACL stayed open; the next `dkg publish` then tripped the
  // pre-publish LU-5 guard with a mismatch error and the operator had
  // no easy path to recover. The fix fails fast at register time with
  // a remediation pointer. These tests pin both the rejection branch
  // and the matching-policy branch so the half-registered state can't
  // slip back in.
  it('rejects register({ accessPolicy: 1 }) on a public-created CG with a remediation message', async () => {
    // Codex r2 on #777: capture the rejection once and assert all
    // substrings against the same error object — the previous draft
    // invoked `registerContextGraph` twice just to match two
    // fragments, and the new guard runs after some local metadata
    // setup so a future refactor could make the second call land in
    // a different state/path while the test still passes.
    const cgId = `f1-mismatch-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    await nodeA!.createContextGraph({ id: cgId, name: 'F1 mismatch', description: '' });

    let caught: Error | undefined;
    try {
      await nodeA!.registerContextGraph(cgId, { accessPolicy: 1 });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'expected register({ accessPolicy: 1 }) to reject').toBeDefined();
    const msg = caught!.message;
    expect(msg, 'message must surface the actual local ACL state').toMatch(
      /local access policy=public\/open \(0\)/i,
    );
    expect(msg, 'message must point at the supported atomic create+register path').toMatch(
      /dkg context-graph create.*--access-policy 1/,
    );
    expect(msg, 'message must mention the single-call API alternative').toMatch(
      /POST \/api\/context-graph\/create/,
    );
  });

  it('accepts register({ accessPolicy: 0 }) on a public-created CG (matching policy is fine)', async () => {
    const cgId = `f1-match-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    await nodeA!.createContextGraph({ id: cgId, name: 'F1 match', description: '' });

    const result = await nodeA!.registerContextGraph(cgId, { accessPolicy: 0 });
    expect(result.onChainId).toBeDefined();
    expect(Number(result.onChainId)).toBeGreaterThan(0);
  });
});
