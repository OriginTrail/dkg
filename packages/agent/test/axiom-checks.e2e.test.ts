/**
 * V10 axiom audit. Per axiom we run multiple sub-rule checks against a real
 * DKGAgent (no mocks). Each sub-rule is a normal vitest `it()` so it shows
 * red on failure. After the suite, we print a per-axiom report with three
 * outcome classes:
 *
 *   PASS    - rule held
 *   BREACH  - assertion fired (the implementation actually disagrees with
 *             the axiom)
 *   MISSING - the API or surface needed to test the rule isn't implemented
 *             yet (e.g. `agent.update is not a function`)
 *
 * BREACH and MISSING both fail the test red. The report just rolls them up
 * by axiom so a human can scan compliance at a glance after the run.
 *
 * Source of truth for the rules: dkgv10-spec/02_AXIOMS.md
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { TrustLevel, TransitionType, ASSERTION_STATES } from '@origintrail-official/dkg-core';
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

const P_NAME = 'http://schema.org/name';
const P_DESC = 'http://schema.org/description';
const PEER_A = '12D3KooWAxiomA0000000000000000000000000000000000000';
const PEER_B = '12D3KooWAxiomB1111111111111111111111111111111111111';

type Outcome = 'PASS' | 'BREACH' | 'MISSING';
interface Finding {
  axiom: number;
  rule: string;
  outcome: Outcome;
  detail?: string;
  where?: string;
}

function extractWhere(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const m = /axiom-checks\.e2e\.test\.ts:(\d+):(\d+)/.exec(stack);
  return m ? `axiom-checks.e2e.test.ts:${m[1]}` : undefined;
}

const findings: Finding[] = [];

function classify(err: string): Outcome {
  // A "missing feature" looks like a runtime/type error, not an assertion mismatch.
  if (
    /is not a function/.test(err) ||
    /Cannot read prop/.test(err) ||
    /TypeError/.test(err) ||
    /ReferenceError/.test(err) ||
    /not implemented/i.test(err) ||
    /unknown.+method/i.test(err)
  ) {
    return 'MISSING';
  }
  return 'BREACH';
}

let snap: string;
let agent: DKGAgent;
let bAddr: string;

function freshCg(label: string): string {
  return `${label}-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
}

function urn(tag: string): string {
  return `urn:axiom:${tag}:${ethers.hexlify(ethers.randomBytes(2)).slice(2)}`;
}

async function rowsFor(
  cg: string,
  view: 'working-memory' | 'shared-working-memory' | 'verified-memory',
  subject: string,
  agentAddress?: string,
): Promise<string[]> {
  const r = await agent.query(
    `SELECT ?o WHERE { <${subject}> <${P_NAME}> ?o }`,
    { contextGraphId: cg, view, agentAddress },
  );
  return r.bindings.map((b: Record<string, string>) => b['o']).filter(Boolean);
}

beforeAll(async () => {
  snap = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const w = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    createProvider(),
    hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    w.address,
    ethers.parseEther('1000000'),
  );

  agent = await DKGAgent.create({
    name: 'AxiomAudit',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await agent.start();
  bAddr = (await agent.registerAgent('B')).agentAddress;
});

afterEach((ctx) => {
  const suiteName = ctx.task.suite?.name ?? '';
  const m = /Axiom\s+(\d+)/.exec(suiteName);
  const axiom = m ? parseInt(m[1], 10) : 0;
  const result = ctx.task.result;
  if (!result) return;
  if (result.state === 'pass') {
    findings.push({ axiom, rule: ctx.task.name, outcome: 'PASS' });
    return;
  }
  if (result.state === 'fail') {
    const err = (result.errors?.[0] as Error | undefined);
    const msg = err?.message ?? 'unknown failure';
    findings.push({
      axiom,
      rule: ctx.task.name,
      outcome: classify(msg),
      detail: msg.split('\n')[0]!.slice(0, 220),
      where: extractWhere(err?.stack),
    });
  }
});

afterAll(async () => {
  try {
    await agent.stop();
  } catch { /* tear-down best effort */ }
  await revertSnapshot(snap);
  printReport(findings);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 1 — Everything in DKG exists within a Context Graph
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 1 — Context Graph isolation', () => {
  it('1.a same IRI in two CGs returns separate values, exactly one row each', async () => {
    const left = freshCg('a1-left');
    const right = freshCg('a1-right');
    const s = urn('shared');
    await agent.createContextGraph({ id: left, name: 'left', description: '' });
    await agent.createContextGraph({ id: right, name: 'right', description: '' });

    const row = (v: string) => ({ subject: s, predicate: P_NAME, object: `"${v}"`, graph: '' });
    await agent.share(left, [row('alpha')], { localOnly: true });
    await agent.share(right, [row('beta')], { localOnly: true });

    const a = await rowsFor(left, 'shared-working-memory', s);
    const b = await rowsFor(right, 'shared-working-memory', s);
    expect(a).toEqual(['"alpha"']);
    expect(b).toEqual(['"beta"']);
  }, 30_000);

  it('1.c private CG with allowedAgents blocks non-listed callers from SWM reads', async () => {
    const cg = freshCg('a1-priv');
    const sub = urn('secret');
    const own = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({
      id: cg,
      name: 'priv',
      description: '',
      private: true,
      allowedAgents: [own],
    });
    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"top-secret"', graph: '' }],
      { localOnly: true },
    );

    const blocked = await agent.query(
      `SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`,
      { contextGraphId: cg, view: 'shared-working-memory', callerAgentAddress: bAddr },
    );
    expect(
      blocked.bindings,
      'private CG with allowedAgents must not return data to a non-listed caller (Axiom 1)',
    ).toHaveLength(0);
  }, 30_000);

  it('1.d publish into a non-existent CG is rejected (every publish targets a CG)', async () => {
    const sub = urn('orphan');
    let threw = false;
    try {
      await agent.publish('cg-does-not-exist-' + ethers.hexlify(ethers.randomBytes(2)).slice(2), [
        { subject: sub, predicate: P_NAME, object: '"x"', graph: '' },
      ]);
    } catch {
      threw = true;
    }
    expect(threw, 'agent.publish to a non-existent context graph must reject (Axiom 1)').toBe(true);
  }, 30_000);

  it('1.b broad SPARQL in CG-A does not return CG-B subjects', async () => {
    const left = freshCg('a1-broadL');
    const right = freshCg('a1-broadR');
    const sLeft = urn('only-left');
    const sRight = urn('only-right');
    await agent.createContextGraph({ id: left, name: 'l', description: '' });
    await agent.createContextGraph({ id: right, name: 'r', description: '' });
    await agent.share(left, [{ subject: sLeft, predicate: P_NAME, object: '"L"', graph: '' }], { localOnly: true });
    await agent.share(right, [{ subject: sRight, predicate: P_NAME, object: '"R"', graph: '' }], { localOnly: true });

    const r = await agent.query(
      `SELECT ?s WHERE { ?s <${P_NAME}> ?o }`,
      { contextGraphId: left, view: 'shared-working-memory' },
    );
    const subs = new Set(r.bindings.map((b: Record<string, string>) => b['s']));
    expect(subs.has(sLeft)).toBe(true);
    expect(subs.has(sRight)).toBe(false);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 2 — Every protected scope has an authority domain
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 2 — Authority domain', () => {
  it('2.a WM is readable by its owning agent', async () => {
    const cg = freshCg('a2-allow');
    const sub = urn('mine');
    const own = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({ id: cg, name: 'allow', description: '' });
    await agent.assertion.create(cg, 'slot');
    await agent.assertion.write(cg, 'slot', [
      { subject: sub, predicate: P_DESC, object: '"mine"', graph: '' },
    ]);

    const ok = await agent.query(
      `SELECT ?o WHERE { <${sub}> <${P_DESC}> ?o }`,
      { contextGraphId: cg, view: 'working-memory', agentAddress: own, callerAgentAddress: own },
    );
    expect(ok.bindings).toHaveLength(1);
    expect(ok.bindings[0]?.['o']).toBe('"mine"');
  }, 30_000);

  it('2.b WM is NOT readable by a different agent (caller != owner)', async () => {
    const cg = freshCg('a2-deny');
    const sub = urn('hidden');
    const own = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({ id: cg, name: 'deny', description: '' });
    await agent.assertion.create(cg, 'slot');
    await agent.assertion.write(cg, 'slot', [
      { subject: sub, predicate: P_DESC, object: '"hidden"', graph: '' },
    ]);

    const blocked = await agent.query(
      `SELECT ?o WHERE { <${sub}> <${P_DESC}> ?o }`,
      { contextGraphId: cg, view: 'working-memory', agentAddress: own, callerAgentAddress: bAddr },
    );
    expect(blocked.bindings).toHaveLength(0);
  }, 30_000);

  it('2.d UPDATE on a non-existent kcId is rejected (publisher-wallet authority on VM updates)', async () => {
    const cg = freshCg('a2-update-auth');
    const sub = urn('upd-auth');
    await agent.createContextGraph({ id: cg, name: 'upd', description: '' });
    await agent.registerContextGraph(cg);
    // We never published any KC with this kcId; updating it must be rejected
    // because there is no authority basis for the caller on this scope.
    let threw = false;
    try {
      await agent.update(999_999_999n, cg, [
        { subject: sub, predicate: P_NAME, object: '"hijack"', graph: '' },
      ]);
    } catch {
      threw = true;
    }
    expect(
      threw,
      'agent.update for a kcId we did not publish must be rejected (no authority basis)',
    ).toBe(true);
  }, 30_000);

  it('2.c SWM ownership: a different peer cannot overwrite an existing rootEntity', async () => {
    const cg = freshCg('a2-own');
    const sub = urn('owned');
    await agent.createContextGraph({ id: cg, name: 'own', description: '' });

    await agent.publisher.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"by-A"', graph: '' }],
      { publisherPeerId: PEER_A },
    );
    let caught: Error | null = null;
    try {
      await agent.publisher.share(
        cg,
        [{ subject: sub, predicate: P_NAME, object: '"by-B"', graph: '' }],
        { publisherPeerId: PEER_B },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'second peer should be rejected by Rule 4 / SWM_ENTITY_OWNED').not.toBeNull();
    expect(caught!.message).toMatch(/Rule 4|already exists|SWM_ENTITY_OWNED/i);
  }, 40_000);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 3 — Every state change is a typed state transition
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 3 — Typed state transitions', () => {
  it('3.a CREATE -> SHARE -> PUBLISH walks all three layers', async () => {
    const cg = freshCg('a3-flow');
    const sub = urn('flow');
    await agent.createContextGraph({ id: cg, name: 'flow', description: '' });
    await agent.registerContextGraph(cg);

    await agent.assertion.create(cg, 'chat');
    await agent.assertion.write(cg, 'chat', [
      { subject: sub, predicate: P_NAME, object: '"v1"', graph: '' },
    ]);
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual([]);

    await agent.assertion.promote(cg, 'chat');
    expect(await rowsFor(cg, 'shared-working-memory', sub)).toEqual(['"v1"']);

    const out = await agent.publishFromSharedMemory(cg, 'all');
    expect(out.status).toBe('confirmed');
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual(['"v1"']);
  }, 60_000);

  it('3.b UPDATE on a published kcId replaces the prior value', async () => {
    const cg = freshCg('a3-update');
    const sub = urn('upd');
    await agent.createContextGraph({ id: cg, name: 'upd', description: '' });
    await agent.registerContextGraph(cg);

    const first = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"v1"', graph: '' },
    ]);
    expect(first.status).toBe('confirmed');
    expect(typeof (agent as unknown as { update?: unknown }).update).toBe('function');
    const second = await agent.update(first.kcId, cg, [
      { subject: sub, predicate: P_NAME, object: '"v2"', graph: '' },
    ]);
    expect(second.status).toBe('confirmed');

    const after = await rowsFor(cg, 'verified-memory', sub);
    expect(after).toContain('"v2"');
    expect(after).not.toContain('"v1"');
  }, 90_000);

  it('3.d TransitionType enum covers all 7 types named in the spec', async () => {
    // dkgv10-spec/02_AXIOMS.md, Axiom 3 transition table:
    // CREATE / UPDATE / REVOKE / SHARE / PUBLISH / VERIFY / DISCARD.
    const required = ['CREATE', 'UPDATE', 'REVOKE', 'SHARE', 'PUBLISH', 'VERIFY', 'DISCARD'];
    const present = Object.values(TransitionType) as string[];
    const missing = required.filter(t => !present.includes(t));
    expect(
      missing,
      `TransitionType is missing the spec types: [${missing.join(', ')}]; current enum: [${present.join(', ')}]`,
    ).toEqual([]);
  });

  it('3.e REVOKE transition is supported by the agent surface', async () => {
    // Spec lists REVOKE in the 7 transition types. There must be a way to
    // invalidate a previously-granted permission/capability. Mark MISSING
    // if no entry point exists. (Discard != Revoke per spec.)
    const a = agent as unknown as { revoke?: unknown };
    const ap = agent.assertion as unknown as { revoke?: unknown };
    const hasRevoke = typeof a.revoke === 'function' || typeof ap.revoke === 'function';
    expect(
      hasRevoke,
      'no REVOKE entry point on agent or agent.assertion (spec requires REVOKE as a typed transition)',
    ).toBe(true);
  });

  it('3.f Assertion lifecycle states match the 5 spec states', async () => {
    // Per Axiom 3 narrative + ASSERTION_STATES contract:
    //   created -> promoted -> published -> finalized; created -> discarded.
    const required = ['created', 'promoted', 'published', 'finalized', 'discarded'];
    const present = ASSERTION_STATES as readonly string[];
    const missing = required.filter(s => !present.includes(s));
    expect(missing, `assertion lifecycle missing: [${missing.join(', ')}]`).toEqual([]);
  });

  it('3.c DISCARD removes WM rows for the discarded assertion', async () => {
    const cg = freshCg('a3-discard');
    const sub = urn('drop');
    const own = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({ id: cg, name: 'drop', description: '' });
    await agent.assertion.create(cg, 'tmp');
    await agent.assertion.write(cg, 'tmp', [
      { subject: sub, predicate: P_NAME, object: '"draft"', graph: '' },
    ]);
    expect(await rowsFor(cg, 'working-memory', sub, own)).toEqual(['"draft"']);

    expect(typeof (agent.assertion as unknown as { discard?: unknown }).discard).toBe('function');
    await agent.assertion.discard(cg, 'tmp');
    expect(await rowsFor(cg, 'working-memory', sub, own)).toEqual([]);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 4 — PUBLISH is the canonical entry to Verified Memory;
//           ENDORSE / VERIFY raise trust within VM.
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 4 — PUBLISH is canonical; ENDORSE/VERIFY raise trust', () => {
  it('4.a SHARE alone leaves VM empty; only PUBLISH lands data', async () => {
    const cg = freshCg('a4-pub');
    const sub = urn('ka');
    await agent.createContextGraph({ id: cg, name: 'pub', description: '' });
    await agent.registerContextGraph(cg);

    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"staged"', graph: '' }],
      { localOnly: true },
    );
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual([]);

    const out = await agent.publishFromSharedMemory(cg, { rootEntities: [sub] });
    expect(out.status).toBe('confirmed');
    expect(out.ual).toContain('did:dkg:evm:31337/');
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual(['"staged"']);
  }, 60_000);

  it('4.b PUBLISH result carries a UAL of the canonical did:dkg:evm form', async () => {
    const cg = freshCg('a4-ual');
    const sub = urn('ual');
    await agent.createContextGraph({ id: cg, name: 'ual', description: '' });
    await agent.registerContextGraph(cg);

    const out = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"u"', graph: '' },
    ]);
    expect(out.status).toBe('confirmed');
    expect(out.ual).toMatch(/^did:dkg:evm:\d+\/0x[0-9a-fA-F]{40}\/\d+$/);
    expect(out.kcId).toBeDefined();
  }, 60_000);

  it('4.d ENDORSE refuses to endorse an unpublished/non-existent UAL', async () => {
    // Spec (Axiom 4): "ENDORSE / VERIFY operate on data already in Verified
    // Memory (data must be published first)". A node accepting an endorsement
    // that points at a UAL no one has published is silently letting trust
    // upgrade ride on imaginary data — direct breach.
    const cg = freshCg('a4-endorse-ghost');
    await agent.createContextGraph({ id: cg, name: 'ghost', description: '' });
    await agent.registerContextGraph(cg);
    let threw = false;
    try {
      await agent.endorse({
        contextGraphId: cg,
        knowledgeAssetUal: 'did:dkg:evm:31337/0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF/999999/1',
      });
    } catch {
      threw = true;
    }
    expect(
      threw,
      'agent.endorse must reject UALs that have not been published (Axiom 4)',
    ).toBe(true);
  }, 30_000);

  it('4.e KC metadata after PUBLISH records transitionType (Axiom 4 corollary)', async () => {
    const cg = freshCg('a4-meta-tt');
    const sub = urn('meta-tt');
    await agent.createContextGraph({ id: cg, name: 'meta', description: '' });
    await agent.registerContextGraph(cg);
    const pub = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"m"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');
    const meta = `did:dkg:context-graph:${cg}/_meta`;
    const r = await agent.store.query(
      `SELECT ?o WHERE { GRAPH <${meta}> { <${pub.ual}> <http://dkg.io/ontology/transitionType> ?o } }`,
    );
    const rows = (r as { bindings?: unknown[] }).bindings ?? [];
    expect(
      rows.length,
      'KC meta must record dkg:transitionType per Axiom 4 corollary (CG, scope, transitionType, authority, evidence, trustLevel)',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('4.f KC metadata after PUBLISH records authorityBasis (Axiom 4 corollary)', async () => {
    const cg = freshCg('a4-meta-auth');
    const sub = urn('meta-auth');
    await agent.createContextGraph({ id: cg, name: 'meta-auth', description: '' });
    await agent.registerContextGraph(cg);
    const pub = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"m"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');
    const meta = `did:dkg:context-graph:${cg}/_meta`;
    const r = await agent.store.query(
      `SELECT ?o WHERE { GRAPH <${meta}> { <${pub.ual}> <http://dkg.io/ontology/authorityBasis> ?o } }`,
    );
    const rows = (r as { bindings?: unknown[] }).bindings ?? [];
    expect(
      rows.length,
      'KC meta must record dkg:authorityBasis per Axiom 4 corollary',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('4.g KC metadata after PUBLISH records trustLevel (Axiom 4 corollary)', async () => {
    const cg = freshCg('a4-meta-tl');
    const sub = urn('meta-tl');
    await agent.createContextGraph({ id: cg, name: 'meta-tl', description: '' });
    await agent.registerContextGraph(cg);
    const pub = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"m"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');
    const meta = `did:dkg:context-graph:${cg}/_meta`;
    const r = await agent.store.query(
      `SELECT ?o WHERE { GRAPH <${meta}> { <${pub.ual}> <http://dkg.io/ontology/trustLevel> ?o } }`,
    );
    const rows = (r as { bindings?: unknown[] }).bindings ?? [];
    expect(
      rows.length,
      'KC meta must record dkg:trustLevel (self-attested at minimum) per Axiom 4 corollary',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('4.c ENDORSE writes an endorsement triple referencing the published UAL', async () => {
    const cg = freshCg('a4-endorse');
    const sub = urn('end');
    await agent.createContextGraph({ id: cg, name: 'end', description: '' });
    await agent.registerContextGraph(cg);

    const pub = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"e"', graph: '' },
    ]);
    expect(pub.status).toBe('confirmed');
    expect(typeof (agent as unknown as { endorse?: unknown }).endorse).toBe('function');

    const endorsed = await agent.endorse({
      contextGraphId: cg,
      knowledgeAssetUal: pub.ual,
    });
    expect(endorsed.status).toBe('confirmed');

    const endorsementsRes = await agent.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(CONTAINS(STR(?o), "${pub.ual}")) }`,
      { contextGraphId: cg, view: 'verified-memory' },
    );
    expect(endorsementsRes.bindings.length).toBeGreaterThan(0);
  }, 90_000);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 5 — Shared Working Memory is staging, not authoritative
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 5 — SWM is provisional staging', () => {
  it('5.a after share: data visible in SWM, absent from VM', async () => {
    const cg = freshCg('a5-stage');
    const sub = urn('stage');
    await agent.createContextGraph({ id: cg, name: 'stage', description: '' });
    await agent.registerContextGraph(cg);
    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"wip"', graph: '' }],
      { localOnly: true },
    );
    expect(await rowsFor(cg, 'shared-working-memory', sub)).toEqual(['"wip"']);
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual([]);
  }, 30_000);

  it('5.b after publish-and-clear: SWM emptied, VM authoritative', async () => {
    const cg = freshCg('a5-clear');
    const sub = urn('clr');
    await agent.createContextGraph({ id: cg, name: 'clr', description: '' });
    await agent.registerContextGraph(cg);
    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"x"', graph: '' }],
      { localOnly: true },
    );
    await agent.publishFromSharedMemory(cg, 'all', { clearSharedMemoryAfter: true });
    expect(await rowsFor(cg, 'shared-working-memory', sub)).toEqual([]);
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual(['"x"']);
  }, 60_000);

  it('5.d SWM record after share is attributed to a producer (prov:wasAttributedTo)', async () => {
    const cg = freshCg('a5-prov-attr');
    const sub = urn('attr');
    await agent.createContextGraph({ id: cg, name: 'attr', description: '' });
    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"x"', graph: '' }],
      { localOnly: true },
    );
    const meta = `did:dkg:context-graph:${cg}/_shared_memory_meta`;
    const r = await agent.store.query(
      `SELECT ?op ?p WHERE { GRAPH <${meta}> {
         ?op a <http://dkg.io/ontology/WorkspaceOperation> .
         ?op <http://www.w3.org/ns/prov#wasAttributedTo> ?p .
       } }`,
    );
    const rows = (r as { bindings?: unknown[] }).bindings ?? [];
    expect(
      rows.length,
      'SWM record must record producer via prov:wasAttributedTo (Axiom 5)',
    ).toBeGreaterThan(0);
  }, 30_000);

  it('5.e SWM record after share carries finality marker = "provisional" (Axiom 5)', async () => {
    const cg = freshCg('a5-final');
    const sub = urn('final');
    await agent.createContextGraph({ id: cg, name: 'final', description: '' });
    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"x"', graph: '' }],
      { localOnly: true },
    );
    const meta = `did:dkg:context-graph:${cg}/_shared_memory_meta`;
    const r = await agent.store.query(
      `SELECT ?f WHERE { GRAPH <${meta}> {
         ?op a <http://dkg.io/ontology/WorkspaceOperation> .
         ?op <http://dkg.io/ontology/finality> ?f .
       } }`,
    );
    const rows = ((r as { bindings?: Record<string, string>[] }).bindings ?? []);
    const literals = rows.map(b => b['f']);
    expect(
      literals.some(v => /provisional/i.test(v ?? '')),
      'SWM record must carry an explicit finality marker = "provisional" (Axiom 5 record contract)',
    ).toBe(true);
  }, 30_000);

  it('5.f SWM record carries transition type (Axiom 5 record contract)', async () => {
    const cg = freshCg('a5-tt');
    const sub = urn('tt');
    await agent.createContextGraph({ id: cg, name: 'tt', description: '' });
    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"x"', graph: '' }],
      { localOnly: true },
    );
    const meta = `did:dkg:context-graph:${cg}/_shared_memory_meta`;
    const r = await agent.store.query(
      `SELECT ?t WHERE { GRAPH <${meta}> {
         ?op a <http://dkg.io/ontology/WorkspaceOperation> .
         ?op <http://dkg.io/ontology/transitionType> ?t .
       } }`,
    );
    const rows = (r as { bindings?: unknown[] }).bindings ?? [];
    expect(
      rows.length,
      'SWM record must record dkg:transitionType (Axiom 5 record contract)',
    ).toBeGreaterThan(0);
  }, 30_000);

  it('5.c SWM is treated as provisional: a fresh VM read of unpublished data is empty', async () => {
    const cg = freshCg('a5-prov');
    const sub = urn('prov');
    await agent.createContextGraph({ id: cg, name: 'prov', description: '' });
    await agent.registerContextGraph(cg);

    await agent.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"draft"', graph: '' }],
      { localOnly: true },
    );

    // Spec rule (Axiom 5): "this state is provisional by nature and is only
    // considered authoritative once explicitly promoted to Verified Memory
    // through PUBLISH". Hence VM must remain empty for any subject that has
    // ONLY been shared, never published.
    expect(await rowsFor(cg, 'verified-memory', sub)).toEqual([]);
    expect(await rowsFor(cg, 'shared-working-memory', sub)).toEqual(['"draft"']);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 6 — Get resolves a declared state view
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 6 — GET resolves a declared view', () => {
  it('6.a each view returns only its own layer', async () => {
    const cg = freshCg('a6-views');
    const wSub = urn('w');
    const sSub = urn('s');
    const vSub = urn('v');
    const own = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({ id: cg, name: 'views', description: '' });
    await agent.registerContextGraph(cg);

    await agent.assertion.create(cg, 'wm');
    await agent.assertion.write(cg, 'wm', [
      { subject: wSub, predicate: P_NAME, object: '"w"', graph: '' },
    ]);
    await agent.share(
      cg,
      [{ subject: sSub, predicate: P_NAME, object: '"s"', graph: '' }],
      { localOnly: true },
    );
    await agent.publish(cg, [
      { subject: vSub, predicate: P_NAME, object: '"v"', graph: '' },
    ]);

    const sel = `SELECT ?s WHERE { ?s <${P_NAME}> ?o }`;
    const wm = await agent.query(sel, { contextGraphId: cg, view: 'working-memory', agentAddress: own });
    const swm = await agent.query(sel, { contextGraphId: cg, view: 'shared-working-memory' });
    const vm = await agent.query(sel, { contextGraphId: cg, view: 'verified-memory' });
    const subs = (r: { bindings: Record<string, string>[] }) => new Set(r.bindings.map(b => b['s']));

    expect(subs(wm)).toEqual(new Set([wSub]));
    expect(subs(swm)).toEqual(new Set([sSub]));
    expect(subs(vm)).toEqual(new Set([vSub]));
  }, 60_000);

  it('6.b minTrust filter excludes a self-attested-only row when caller asks for consensus-verified', async () => {
    const cg = freshCg('a6-trust');
    const sub = urn('t');
    await agent.createContextGraph({ id: cg, name: 't', description: '' });
    await agent.registerContextGraph(cg);
    await agent.publish(cg, [{ subject: sub, predicate: P_NAME, object: '"t"', graph: '' }]);

    // Self-attested floor: the row exists at the lowest VM trust level.
    const atFloor = await agent.query(
      `SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`,
      { contextGraphId: cg, view: 'verified-memory', minTrust: TrustLevel.SelfAttested },
    );
    expect(atFloor.bindings.length).toBeGreaterThanOrEqual(1);

    // Axiom 6: minTrust must filter. A row that has not been quorum-verified
    // must not be returned when the caller asks for consensus-verified data.
    // An implementation may also choose to reject the request — both satisfy
    // the rule because neither of them surfaces under-trusted data.
    let returned: number;
    try {
      const r = await agent.query(
        `SELECT ?o WHERE { <${sub}> <${P_NAME}> ?o }`,
        { contextGraphId: cg, view: 'verified-memory', minTrust: TrustLevel.ConsensusVerified },
      );
      returned = r.bindings.length;
    } catch {
      returned = 0;
    }
    expect(returned).toBe(0);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────
// Axiom 7 — Conflicts are resolved by deterministic protocol rules
// ────────────────────────────────────────────────────────────────────────

describe('Axiom 7 — Deterministic conflict resolution', () => {
  it('7.a concurrent shares from two peers: exactly one wins', async () => {
    const cg = freshCg('a7-race');
    const sub = urn('race');
    await agent.createContextGraph({ id: cg, name: 'race', description: '' });
    const shareAs = (peer: string, lit: string) =>
      agent.publisher.share(
        cg,
        [{ subject: sub, predicate: P_NAME, object: `"${lit}"`, graph: '' }],
        { publisherPeerId: peer },
      );
    const out = await Promise.allSettled([shareAs(PEER_A, 'a'), shareAs(PEER_B, 'b')]);
    const ok = out.filter(x => x.status === 'fulfilled');
    const bad = out.filter(x => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    const err = (bad[0] as PromiseRejectedResult).reason as Error;
    expect(err.message).toMatch(/Rule 4|already exists|SWM_ENTITY_OWNED/i);
    const survivor = await rowsFor(cg, 'shared-working-memory', sub);
    expect(survivor).toHaveLength(1);
    expect(['"a"', '"b"']).toContain(survivor[0]);
  }, 60_000);

  it('7.b same peer can re-write its own rootEntity (upsert path)', async () => {
    const cg = freshCg('a7-upsert');
    const sub = urn('up');
    await agent.createContextGraph({ id: cg, name: 'up', description: '' });
    await agent.publisher.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"v1"', graph: '' }],
      { publisherPeerId: PEER_A },
    );
    await agent.publisher.share(
      cg,
      [{ subject: sub, predicate: P_NAME, object: '"v2"', graph: '' }],
      { publisherPeerId: PEER_A },
    );
    const v = await rowsFor(cg, 'shared-working-memory', sub);
    expect(v).toContain('"v2"');
  }, 30_000);

  it('7.d competing UPDATEs for the same kcId resolve deterministically (no double-confirm)', async () => {
    const cg = freshCg('a7-update-race');
    const sub = urn('upd-race');
    await agent.createContextGraph({ id: cg, name: 'upd-race', description: '' });
    await agent.registerContextGraph(cg);
    const first = await agent.publish(cg, [
      { subject: sub, predicate: P_NAME, object: '"v0"', graph: '' },
    ]);
    expect(first.status).toBe('confirmed');

    const updateA = agent.update(first.kcId, cg, [
      { subject: sub, predicate: P_NAME, object: '"vA"', graph: '' },
    ]);
    const updateB = agent.update(first.kcId, cg, [
      { subject: sub, predicate: P_NAME, object: '"vB"', graph: '' },
    ]);
    const out = await Promise.allSettled([updateA, updateB]);
    const confirmed = out.filter(
      x => x.status === 'fulfilled' && (x as PromiseFulfilledResult<{ status: string }>).value.status === 'confirmed',
    );
    expect(
      confirmed.length,
      'two concurrent updates for the same kcId must not both confirm — deterministic conflict resolution required (Axiom 7)',
    ).toBeLessThanOrEqual(1);
  }, 90_000);

  it('7.c different rootEntities on the same CG: no false-positive lock', async () => {
    const cg = freshCg('a7-indep');
    const a = urn('A');
    const b = urn('B');
    await agent.createContextGraph({ id: cg, name: 'indep', description: '' });
    await agent.publisher.share(
      cg,
      [{ subject: a, predicate: P_NAME, object: '"A"', graph: '' }],
      { publisherPeerId: PEER_A },
    );
    await agent.publisher.share(
      cg,
      [{ subject: b, predicate: P_NAME, object: '"B"', graph: '' }],
      { publisherPeerId: PEER_B },
    );
    expect(await rowsFor(cg, 'shared-working-memory', a)).toEqual(['"A"']);
    expect(await rowsFor(cg, 'shared-working-memory', b)).toEqual(['"B"']);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────
// Report
// ────────────────────────────────────────────────────────────────────────

const AXIOM_TITLES: Record<number, string> = {
  1: 'Context Graph isolation',
  2: 'Authority domain',
  3: 'Typed state transitions',
  4: 'PUBLISH is canonical; ENDORSE/VERIFY raise trust',
  5: 'SWM is provisional staging',
  6: 'GET resolves a declared view',
  7: 'Deterministic conflict resolution',
};

function printReport(rs: Finding[]): void {
  const out: string[] = [];
  const bar = '='.repeat(72);
  out.push('', bar, 'V10 AXIOM COMPLIANCE REPORT', bar);

  let totalAxioms = 0;
  let cleanAxioms = 0;

  for (const axiom of [1, 2, 3, 4, 5, 6, 7]) {
    const group = rs.filter(r => r.axiom === axiom);
    if (group.length === 0) continue;
    totalAxioms += 1;
    const pass = group.filter(r => r.outcome === 'PASS').length;
    const breach = group.filter(r => r.outcome === 'BREACH').length;
    const missing = group.filter(r => r.outcome === 'MISSING').length;
    const total = group.length;
    if (breach + missing === 0) cleanAxioms += 1;

    const summary =
      breach + missing === 0
        ? `${pass}/${total} PASS`
        : `${pass}/${total} PASS` +
          (breach ? `, ${breach} BREACH` : '') +
          (missing ? `, ${missing} MISSING` : '');

    out.push('', `Axiom ${axiom} — ${AXIOM_TITLES[axiom]}    [${summary}]`);
    for (const r of group) {
      const tag =
        r.outcome === 'PASS' ? 'PASS  ' : r.outcome === 'BREACH' ? 'BREACH' : 'MISSING';
      out.push(`  ${tag}  ${r.rule}`);
      if (r.where) {
        out.push(`         where: ${r.where}`);
      }
      if (r.detail) {
        out.push(`         why:   ${r.detail}`);
      }
    }
  }

  out.push('', bar);
  out.push(`SUMMARY: ${cleanAxioms}/${totalAxioms} axioms fully compliant`);
  if (cleanAxioms !== totalAxioms) {
    out.push('Run `pnpm test:axioms` to re-check after fixing the breaches above.');
  }
  out.push(bar, '');

  // Single console.log so the whole block lands together in test output.
  console.log(out.join('\n'));
}
