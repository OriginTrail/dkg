/**
 * /api/knowledge-assets route family — REAL daemon, REAL chain, NO mocks.
 *
 * The retired version hand-assembled a `RequestContext` (fake req/res, fake
 * tracker, fake dashDb, fake SSE emitters) and a fake `agent` whose every
 * lifecycle method was a vitest-fn returning canned data — including
 * hand-typed engine error strings ("assertion not found", "is not finalized",
 * "No quads in shared memory", merkleRoot `new Uint8Array([0xab,0xcd])`). That
 * is exactly the drift surface: the route's error→HTTP mapping and lifecycle
 * contracts were pinned against fabricated strings/shapes that can diverge
 * from what the real engine throws.
 *
 * This version drives the routes over real HTTP against a real edge daemon
 * wired to the shared Hardhat node (so on-chain CG registration + finalize
 * succeed). Every status code, error string, merkle root, and side-effect is
 * the REAL one. Two un-provokable concerns are split out:
 *   - `classifyVmPublish` / `respondAssertionError` outcome-mapping branches
 *     that need a real 207/502/AssertionNotPersisted/payload-too-large (which
 *     a single happy node can't manufacture). The route keeps these helpers
 *     module-private, so — to stay strictly test-only (no source `export`) —
 *     they are NOT unit-tested here; the reachable 400/409 branches are
 *     covered via the live daemon, the rest documented at the bottom.
 *   - genuinely multi-node behaviours (a confirmed vm/publish MINT needs
 *     StorageACK quorum from core peers — an edge node 500s "no connected core
 *     peers"; cross-node B3 pointer divergence; the async-promote worker
 *     advancing job state) are documented as devnet-tier at the bottom.
 *   - GH #1094: wm/pull-from 500s "No sealed entity list" on every path today;
 *     only its missing-`layer` validator converts, the happy/409 paths are
 *     pinned as a known-bug assertion.
 *
 * Verified real shapes (probed live before writing): create → 201
 * {status:'draft-open', alreadyExists}; finalize → real 32-byte merkleRoot;
 * publish-unshared → 409 VM_PUBLISH_PRECONDITION; publish-not-finalized → 409;
 * GET /:name → {state:'created', memoryLayer:'WM'}; import-file → 200 with a
 * keccak256 fileHash; share-async → 200 {state:'queued'}.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startLiveDaemon,
  stopLiveDaemon,
  postJson,
  getJson,
  postMultipart,
  type LiveDaemon,
} from './helpers/live-daemon.js';

// Local (off-chain) CG — enough for create/write/quads/descriptor/import.
const LOCAL = `ka-loc-${Date.now().toString(36)}`;
// #1116 (round 6): a SEPARATE created-but-UNregistered CG, used ONLY by the
// /vm/publish auto-register test. That test AUTO-REGISTERS its CG on-chain, so it
// must not mutate the shared `LOCAL` (a later test relies on LOCAL having no
// trusted on-chain mapping). No other test references this id.
const LOCAL_AUTOREG = `ka-autoreg-${Date.now().toString(36)}`;
// #1116 (round 6): a SEPARATE created-but-UNregistered CG, used ONLY by the FIX 2
// gas-preflight route test (finalized-but-NOT-shared → empty SWM → no-quads
// precondition must fire BEFORE any registration tx). The CG must stay UNregistered
// after the call (proving no gas was burned), so it cannot share the auto-register
// CG. No other test references this id.
const LOCAL_NOSHARE = `ka-noshare-${Date.now().toString(36)}`;
// On-chain-registered CG — required for finalize/share/publish preconditions.
const REG = `ka-reg-${Date.now().toString(36)}`;
// On-chain-registered PUBLIC CG — for preconditions that only hold on the public
// path. Post OT-RFC-49 a CURATED CG can publish catalog-only (the catalog IS the
// commitment), so "nothing shared" is no longer a precondition there; the public
// "No quads in shared memory" precondition still holds and is checked via this CG.
const PUBREG = `ka-pubreg-${Date.now().toString(36)}`;

let daemon: LiveDaemon;
let ownerAddress = '';

async function createKa(cg: string, name: string, extra: Record<string, unknown> = {}) {
  return postJson(daemon, '/api/knowledge-assets', { contextGraphId: cg, name, ...extra });
}
async function write(cg: string, name: string, quads: unknown[]) {
  return postJson(daemon, `/api/knowledge-assets/${name}/wm/write`, { contextGraphId: cg, quads });
}
async function wmQuads(cg: string, name: string) {
  return getJson(daemon, `/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads?contextGraphId=${cg}`);
}
async function postJsonAsAgent(authToken: string, path: string, body: unknown) {
  const r = await fetch(`${daemon.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
async function getJsonAsAgent(authToken: string, path: string) {
  const r = await fetch(`${daemon.base}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
async function registerAgentClient(label: string) {
  const reg = await postJson(daemon, '/api/agent/register', {
    name: `${label}-${Date.now().toString(36)}`,
    framework: 'test',
  });
  expect(reg.status, `${label} register: ${JSON.stringify(reg.body)}`).toBeLessThan(300);
  const agentAddress = String(reg.body.agentAddress);
  const authToken = String(reg.body.authToken);
  expect(agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(authToken.length).toBeGreaterThan(0);
  return {
    agentAddress,
    authToken,
    post: (path: string, body: unknown) => postJsonAsAgent(authToken, path, body),
    get: (path: string) => getJsonAsAgent(authToken, path),
  };
}
async function createRegisteredAgentContextGraph(
  agent: Awaited<ReturnType<typeof registerAgentClient>>,
  id: string,
) {
  const created = await agent.post('/api/context-graph/create', { id, name: id, accessPolicy: 1 });
  expect(created.status, `agent CG create: ${JSON.stringify(created.body)}`).toBeLessThan(300);
  const registered = await agent.post('/api/context-graph/register', { id, accessPolicy: 1 });
  expect(registered.status, `agent CG register: ${JSON.stringify(registered.body)}`).toBe(200);
}

describe('/api/knowledge-assets routes (real daemon, real chain)', () => {
  beforeAll(async () => {
    daemon = await startLiveDaemon();
    const loc = await postJson(daemon, '/api/context-graph/create', { id: LOCAL, name: 'Local' });
    expect(loc.status, `local CG create: ${JSON.stringify(loc.body)}`).toBeLessThan(300);
    // #1116 (round 6): dedicated unregistered CG for the auto-register test — created
    // (off-chain) here, NOT registered, so the test can drive the publish-time
    // registration without polluting the shared `LOCAL`.
    const locAutoreg = await postJson(daemon, '/api/context-graph/create', { id: LOCAL_AUTOREG, name: 'Local Autoreg' });
    expect(locAutoreg.status, `local autoreg CG create: ${JSON.stringify(locAutoreg.body)}`).toBeLessThan(300);
    // #1116 (round 6): dedicated unregistered CG for the FIX 2 gas-preflight test —
    // created off-chain, NEVER registered, so the test can prove the no-quads
    // precondition fires before any registration tx (and the CG stays unregistered).
    const locNoshare = await postJson(daemon, '/api/context-graph/create', { id: LOCAL_NOSHARE, name: 'Local NoShare' });
    expect(locNoshare.status, `local noshare CG create: ${JSON.stringify(locNoshare.body)}`).toBeLessThan(300);
    const reg = await postJson(daemon, '/api/context-graph/create', { id: REG, name: 'Reg', accessPolicy: 1 });
    expect(reg.status, `reg CG create: ${JSON.stringify(reg.body)}`).toBeLessThan(300);
    const onchain = await postJson(daemon, '/api/context-graph/register', { id: REG, accessPolicy: 1 });
    expect(onchain.status, `on-chain register: ${JSON.stringify(onchain.body)}`).toBe(200);
    const pubCreate = await postJson(daemon, '/api/context-graph/create', { id: PUBREG, name: 'PubReg', accessPolicy: 0 });
    expect(pubCreate.status, `pub CG create: ${JSON.stringify(pubCreate.body)}`).toBeLessThan(300);
    const pubReg = await postJson(daemon, '/api/context-graph/register', { id: PUBREG, accessPolicy: 0 });
    expect(pubReg.status, `pub on-chain register: ${JSON.stringify(pubReg.body)}`).toBe(200);

    // Capture the daemon's REAL custodial owner agent address from a create
    // response's assertionUri (…/_working_memory/<ADDR>/<n>) — used to build
    // the import/extraction assertion URIs, never a pinned 0x..01.
    const seed = await createKa(LOCAL, 'addr-seed');
    ownerAddress = String(seed.body.assertionUri).split('/_working_memory/')[1].split('/')[0];
    expect(ownerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  // ── create + idempotency + reserved identifiers ───────────────────
  describe('POST /api/knowledge-assets (create)', () => {
    it('creates a KA and opens a WM draft', async () => {
      const res = await createKa(LOCAL, 'meeting-notes');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'meeting-notes', status: 'draft-open', alreadyExists: false });
    });

    it('reports alreadyExists on a real get-or-create re-create', async () => {
      await createKa(LOCAL, 'dup');
      const second = await createKa(LOCAL, 'dup');
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ name: 'dup', alreadyExists: true });
    });

    it('keeps a compact 0x<agent>:<number> string as a literal name', async () => {
      const name = `0x${'ab'.repeat(20)}:5`;
      const res = await createKa(LOCAL, name);
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(name);
    });

    it('reserves did:dkg UAL identifiers (400 KA_IDENTIFIER_RESERVED, no draft)', async () => {
      const res = await createKa(LOCAL, 'did:dkg:evm:31337/0xkaaddr/123');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('KA_IDENTIFIER_RESERVED');
    });

    it('rejects finalize-only fields without auto-finalize quads (400)', async () => {
      for (const payload of [{ authorAgentAddress: `0x${'11'.repeat(20)}` }, { quads: [], schemeVersion: 1 }]) {
        const res = await createKa(REG, 'rej-finalize-only', payload);
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toContain('require non-empty "quads"');
      }
    });

    it('rejects mutually-exclusive atomic-finalize authorship fields (400)', async () => {
      const res = await createKa(REG, 'rej-authorship', {
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        authorAgentAddress: `0x${'11'.repeat(20)}`,
        preSignedAuthorAttestation: { address: `0x${'11'.repeat(20)}`, reservedKaId: '1', signature: { r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` } },
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/mutually exclusive/);
    });

    it('atomic create with quads auto-writes + auto-finalizes (real seal, 0x merkle root)', async () => {
      const res = await createKa(REG, 'atomic-seal', {
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
      });
      expect(res.status).toBe(201);
      // Real seal — a full 32-byte keccak root, never the mock's 0xabcd.
      if (res.body.merkleRoot !== undefined) {
        expect(String(res.body.merkleRoot)).toMatch(/^0x[0-9a-f]{8,}$/);
      }
    });

    it('atomic create without an explicit author seals as the agent-scoped token', async () => {
      const agent = await registerAgentClient('ka-atomic-default-author');
      const cg = `ka-atomic-default-${Date.now().toString(36)}`;
      await createRegisteredAgentContextGraph(agent, cg);

      const res = await agent.post('/api/knowledge-assets', {
        contextGraphId: cg,
        name: 'agent-default-atomic',
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
      });

      expect(res.status, `agent atomic create: ${JSON.stringify(res.body)}`).toBe(201);
      expect(String(res.body.authorAddress).toLowerCase()).toBe(agent.agentAddress.toLowerCase());
      const descriptor = await agent.get(
        `/api/knowledge-assets/agent-default-atomic?contextGraphId=${cg}&agentAddress=${agent.agentAddress}`,
      );
      expect(descriptor.status, `agent atomic descriptor: ${JSON.stringify(descriptor.body)}`).toBe(200);
      expect(descriptor.body.status).toBe('wm-sealed');
      expect(String(descriptor.body.agentAddress).toLowerCase()).toBe(agent.agentAddress.toLowerCase());
      expect(descriptor.body.wmCurrentAssertion).toBeTruthy();
    });

    it('atomic create canonicalizes a mixed-case self authorAgentAddress before sealing', async () => {
      const agent = await registerAgentClient('ka-atomic-author-case');
      const cg = `ka-atomic-author-case-${Date.now().toString(36)}`;
      await createRegisteredAgentContextGraph(agent, cg);
      const mixedCaseAgent = `0x${agent.agentAddress.slice(2).toUpperCase()}`;
      expect(mixedCaseAgent).not.toBe(agent.agentAddress);

      const res = await agent.post('/api/knowledge-assets', {
        contextGraphId: cg,
        name: 'agent-case-atomic',
        quads: [{ subject: 'ex:Case', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
        authorAgentAddress: mixedCaseAgent,
      });

      expect(res.status, `mixed-case atomic create: ${JSON.stringify(res.body)}`).toBe(201);
      expect(String(res.body.authorAddress).toLowerCase()).toBe(agent.agentAddress.toLowerCase());
    });

    it('rejects mismatched atomic create authorAgentAddress before opening a draft', async () => {
      const agentA = await registerAgentClient('ka-atomic-author-a');
      const agentB = await registerAgentClient('ka-atomic-author-b');
      const cg = `ka-atomic-author-guard-${Date.now().toString(36)}`;
      const name = 'agent-mismatch-atomic';
      await createRegisteredAgentContextGraph(agentA, cg);

      const res = await agentA.post('/api/knowledge-assets', {
        contextGraphId: cg,
        name,
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
        authorAgentAddress: agentB.agentAddress,
      });

      expect(res.status, `mismatched atomic create: ${JSON.stringify(res.body)}`).toBe(403);
      expect(String(res.body.error)).toContain(agentA.agentAddress);
      expect(String(res.body.error)).toContain(agentB.agentAddress);
      const descriptor = await agentA.get(
        `/api/knowledge-assets/${name}?contextGraphId=${cg}&agentAddress=${agentA.agentAddress}`,
      );
      expect(descriptor.status, `post-403 descriptor: ${JSON.stringify(descriptor.body)}`).toBe(404);
    });

    it('rejects mismatched atomic create pre-signed author before opening a draft', async () => {
      const agentA = await registerAgentClient('ka-atomic-attestation-a');
      const agentB = await registerAgentClient('ka-atomic-attestation-b');
      const cg = `ka-atomic-attestation-guard-${Date.now().toString(36)}`;
      const name = 'agent-attestation-mismatch-atomic';
      await createRegisteredAgentContextGraph(agentA, cg);

      const res = await agentA.post('/api/knowledge-assets', {
        contextGraphId: cg,
        name,
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
        preSignedAuthorAttestation: {
          address: agentB.agentAddress,
          reservedKaId: '1',
          signature: { r: `0x${'11'.repeat(32)}`, vs: `0x${'22'.repeat(32)}` },
        },
      });

      expect(res.status, `mismatched atomic attestation: ${JSON.stringify(res.body)}`).toBe(403);
      expect(String(res.body.error)).toContain(agentA.agentAddress);
      expect(String(res.body.error)).toContain(agentB.agentAddress);
      const descriptor = await agentA.get(
        `/api/knowledge-assets/${name}?contextGraphId=${cg}&agentAddress=${agentA.agentAddress}`,
      );
      expect(descriptor.status, `post-403 descriptor: ${JSON.stringify(descriptor.body)}`).toBe(404);
    });
  });

  // ── wm/write lifecycle (create-before-write, append-only, re-create) ──
  describe('wm/write lifecycle', () => {
    it('appends quads and grows the draft', async () => {
      await createKa(LOCAL, 'w1');
      const res = await write(LOCAL, 'w1', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      expect(res.status).toBe(200);
      expect(res.body.written).toBe(1);
      expect((await wmQuads(LOCAL, 'w1')).body.count).toBe(1);
    });

    it('creates a MISSING KA before the first append (descriptor becomes resolvable)', async () => {
      const res = await write(LOCAL, 'brand-new', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      expect(res.status).toBe(200);
      // The real-world proof create() ran first: the lifecycle record now exists.
      const descriptor = await getJson(daemon, `/api/knowledge-assets/brand-new?contextGraphId=${LOCAL}`);
      expect(descriptor.status).toBe(200);
    });

    it('does NOT re-create an existing KA (append-only: earlier quads survive)', async () => {
      await createKa(LOCAL, 'append-only');
      await write(LOCAL, 'append-only', [{ subject: 'ex:first', predicate: 'ex:p', object: '"1"' }]);
      await write(LOCAL, 'append-only', [{ subject: 'ex:second', predicate: 'ex:p', object: '"2"' }]);
      // Re-create would have wiped the first write; data survival is the observable.
      const { body } = await wmQuads(LOCAL, 'append-only');
      expect(body.count).toBe(2);
      expect(JSON.stringify(body.quads)).toContain('ex:first');
    });

    it('re-creates a DISCARDED KA before appending (only the post-discard quad remains)', async () => {
      await createKa(LOCAL, 'rediscard');
      await write(LOCAL, 'rediscard', [{ subject: 'ex:old', predicate: 'ex:p', object: '"old"' }]);
      await postJson(daemon, '/api/knowledge-assets/rediscard/wm/discard', { contextGraphId: LOCAL });
      await write(LOCAL, 'rediscard', [{ subject: 'ex:new', predicate: 'ex:p', object: '"new"' }]);
      const { body } = await wmQuads(LOCAL, 'rediscard');
      expect(body.count).toBe(1);
      expect(JSON.stringify(body.quads)).toContain('ex:new');
      expect(JSON.stringify(body.quads)).not.toContain('ex:old');
    });
  });

  // ── wm/quads ──────────────────────────────────────────────────────
  describe('GET wm/quads', () => {
    it('returns the draft quads sorted with a count', async () => {
      await createKa(LOCAL, 'sorted');
      await write(LOCAL, 'sorted', [
        { subject: 'ex:Z', predicate: 'ex:p', object: '"z"' },
        { subject: 'ex:A', predicate: 'ex:p', object: '"a"' },
      ]);
      const { status, body } = await wmQuads(LOCAL, 'sorted');
      expect(status).toBe(200);
      expect(body.count).toBe(2);
      // Sorted: ex:A precedes ex:Z.
      expect(body.quads[0].subject).toBe('ex:A');
    });

    it('rejects a bad assertion name (400, no query)', async () => {
      const { status, body } = await wmQuads(LOCAL, 'bad name with spaces');
      expect(status).toBe(400);
      expect(String(body.error)).toContain('Invalid "name"');
    });

    it('an empty draft dumps zero quads', async () => {
      await createKa(LOCAL, 'empty-draft');
      const { status, body } = await wmQuads(LOCAL, 'empty-draft');
      expect(status).toBe(200);
      expect(body.count).toBe(0);
    });
  });

  // ── wm/finalize ───────────────────────────────────────────────────
  describe('wm/finalize', () => {
    it('seals the draft and returns the full real seal payload', async () => {
      await createKa(REG, 'seal');
      await write(REG, 'seal', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      const res = await postJson(daemon, '/api/knowledge-assets/seal/wm/finalize', { contextGraphId: REG });
      expect(res.status).toBe(200);
      expect(String(res.body.merkleRoot)).toMatch(/^0x[0-9a-f]{8,}$/);
      expect(String(res.body.authorAddress)).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(res.body.assertionUri).toMatch(/^did:dkg:/);
    });

    // GH#1759 — finalizing a draft with no quads is a client precondition
    // failure, not a server fault. It used to fall through
    // `respondAssertionError` to a generic 500 because the engine threw an
    // untagged Error and the message matched none of the 400 substrings.
    it('returns 409 ASSERTION_EMPTY when finalizing a draft with no quads', async () => {
      await createKa(REG, 'fin-empty');
      const res = await postJson(daemon, '/api/knowledge-assets/fin-empty/wm/finalize', { contextGraphId: REG });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ASSERTION_EMPTY');
      expect(String(res.body.error)).toContain('it has no quads');
    });

    it('still seals normally after the empty draft is given a quad', async () => {
      await createKa(REG, 'fin-empty-then-filled');
      const empty = await postJson(daemon, '/api/knowledge-assets/fin-empty-then-filled/wm/finalize', { contextGraphId: REG });
      expect(empty.status).toBe(409);

      await write(REG, 'fin-empty-then-filled', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      const sealed = await postJson(daemon, '/api/knowledge-assets/fin-empty-then-filled/wm/finalize', { contextGraphId: REG });
      expect(sealed.status).toBe(200);
      expect(String(sealed.body.merkleRoot)).toMatch(/^0x[0-9a-f]{8,}$/);
    });

    it('rejects a malformed pre-signed attestation (bad signature.r) before finalize', async () => {
      await createKa(REG, 'att-r');
      await write(REG, 'att-r', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      const res = await postJson(daemon, '/api/knowledge-assets/att-r/wm/finalize', {
        contextGraphId: REG,
        preSignedAuthorAttestation: { address: `0x${'11'.repeat(20)}`, reservedKaId: '1', signature: { r: '0xshort', vs: `0x${'22'.repeat(32)}` } },
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('preSignedAuthorAttestation.signature.r');
    });

    it('rejects a pre-signed attestation missing reservedKaId (§F2)', async () => {
      await createKa(REG, 'att-kaid');
      await write(REG, 'att-kaid', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      const res = await postJson(daemon, '/api/knowledge-assets/att-kaid/wm/finalize', {
        contextGraphId: REG,
        preSignedAuthorAttestation: { address: `0x${'11'.repeat(20)}`, signature: { r: `0x${'11'.repeat(32)}`, vs: `0x${'22'.repeat(32)}` } },
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('preSignedAuthorAttestation.reservedKaId');
    });

    // F1 regression — a custodial agent's bearer token must attribute the seal's
    // author to that agent (not the node's publisher signer). The on-chain
    // getLatestMerkleRootAuthor derives from this seal author, so before the fix
    // a custodial publish recorded the node's operational wallet as author.
    // (Admin-token "publisher signs as itself" is covered in the unit test
    // finalize-author-token-attribution.test.ts; here we prove the agent path
    // end-to-end through the real daemon + real seal.)
    it('attributes the seal author to the agent-scoped token (F1)', async () => {
      const reg = await postJson(daemon, '/api/agent/register', {
        name: `ka-author-agent-${Date.now().toString(36)}`,
        framework: 'test',
      });
      expect(reg.status, `agent register: ${JSON.stringify(reg.body)}`).toBeLessThan(300);
      const agentAddress = String(reg.body.agentAddress);
      const agentToken = String(reg.body.authToken);
      expect(agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(agentToken.length).toBeGreaterThan(0);

      // All requests run AS the custodial agent (raw fetch — postJson uses the
      // node-admin token). The agent authors into its own CG.
      const agentPost = async (path: string, body: unknown) => {
        const r = await fetch(`${daemon.base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
          body: JSON.stringify(body),
        });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
      };

      const cg = `ka-agent-cg-${Date.now().toString(36)}`;
      const created = await agentPost('/api/context-graph/create', { id: cg, name: 'Agent CG', accessPolicy: 1 });
      expect(created.status, `agent CG create: ${JSON.stringify(created.body)}`).toBeLessThan(300);
      const onchain = await agentPost('/api/context-graph/register', { id: cg, accessPolicy: 1 });
      expect(onchain.status, `agent CG register: ${JSON.stringify(onchain.body)}`).toBe(200);

      // Create draft → write → finalize, all as the agent. The kaId is stamped
      // (at create) AND the seal is signed (at finalize) in the SAME agent
      // namespace, so finalize doesn't throw KaIdNamespaceMismatch and the seal
      // author is the agent. The finalize route returns the sealed authorAddress.
      const created2 = await agentPost('/api/knowledge-assets', { contextGraphId: cg, name: 'agent-authored' });
      expect(created2.status, `agent KA create: ${JSON.stringify(created2.body)}`).toBeLessThan(300);
      await agentPost('/api/knowledge-assets/agent-authored/wm/write', {
        contextGraphId: cg,
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
      });
      const fin = await agentPost('/api/knowledge-assets/agent-authored/wm/finalize', { contextGraphId: cg });
      expect(fin.status, `agent finalize: ${JSON.stringify(fin.body)}`).toBe(200);
      // The fix: stamp + seal are both in the agent's namespace → seal author is
      // the agent, not the node's publisher signer.
      expect(String(fin.body.authorAddress).toLowerCase()).toBe(agentAddress.toLowerCase());

      // ATOMIC path (the create-route callsite this PR changes): create + write +
      // auto-finalize + share + publish in ONE call, as the agent. This proves
      // write/finalize/promote/publish all stay in the AGENT's namespace, not just
      // create — the returned author is the agent, and (when it mints) the kaId is
      // packed (uint160(author)<<96)|number, so its high 160 bits MUST be the agent.
      const atomic = await agentPost('/api/knowledge-assets', {
        contextGraphId: cg,
        name: 'agent-atomic',
        quads: [{ subject: 'ex:B', predicate: 'ex:p', object: '"y"' }],
        finalize: true,
        alsoShareSwm: true,
        alsoPublishVm: true,
      });
      // authorAddress is stamped at finalize (before any publish tail-error), so
      // it is always present and must be the agent.
      expect(String(atomic.body.authorAddress).toLowerCase(), `agent atomic: ${JSON.stringify(atomic.body)}`).toBe(
        agentAddress.toLowerCase(),
      );
      // If it minted on-chain, the minted kaId proves the publish path stayed
      // agent-scoped (high 160 bits == author == agent).
      if (atomic.body.kaId != null) {
        expect(BigInt(atomic.body.kaId) >> 96n).toBe(BigInt(agentAddress));
      }
    });

    it('node token finalizes an explicitly selected local author lane', async () => {
      const agent = await registerAgentClient('ka-node-finalize-author');
      const cg = `ka-node-finalize-${Date.now().toString(36)}`;
      const name = 'node-explicit-author-finalize';
      await createRegisteredAgentContextGraph(agent, cg);

      const draft = await agent.post('/api/knowledge-assets', {
        contextGraphId: cg,
        name,
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: false,
      });
      expect(draft.status, `agent draft create: ${JSON.stringify(draft.body)}`).toBe(201);
      expect(draft.body.status).toBe('draft-open');

      const fin = await postJson(daemon, `/api/knowledge-assets/${name}/wm/finalize`, {
        contextGraphId: cg,
        authorAgentAddress: agent.agentAddress,
      });
      expect(fin.status, `node finalize override: ${JSON.stringify(fin.body)}`).toBe(200);
      expect(String(fin.body.authorAddress).toLowerCase()).toBe(agent.agentAddress.toLowerCase());

      const descriptor = await agent.get(
        `/api/knowledge-assets/${name}?contextGraphId=${cg}&agentAddress=${agent.agentAddress}`,
      );
      expect(descriptor.status, `agent descriptor: ${JSON.stringify(descriptor.body)}`).toBe(200);
      expect(descriptor.body.status).toBe('wm-sealed');
    });
  });

  // ── swm/share ─────────────────────────────────────────────────────
  describe('swm/share', () => {
    it('advances the SWM pointer (real promote→share)', async () => {
      await createKa(REG, 'share');
      await write(REG, 'share', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      await postJson(daemon, '/api/knowledge-assets/share/wm/finalize', { contextGraphId: REG });
      const res = await postJson(daemon, '/api/knowledge-assets/share/swm/share', { contextGraphId: REG });
      expect(res.status).toBe(200);
      expect(res.body.swmShared).toBe(true);
      expect(res.body.promotedCount).toBeGreaterThan(0);
    });

    it('agent-scoped token full share auto-seals as the token agent', async () => {
      const agent = await registerAgentClient('ka-share-default-author');
      const cg = `ka-share-default-${Date.now().toString(36)}`;
      const name = 'agent-default-share';
      await createRegisteredAgentContextGraph(agent, cg);

      const draft = await agent.post('/api/knowledge-assets', {
        contextGraphId: cg,
        name,
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: false,
      });
      expect(draft.status, `agent draft: ${JSON.stringify(draft.body)}`).toBe(201);
      expect(draft.body.status).toBe('draft-open');

      const res = await agent.post(`/api/knowledge-assets/${name}/swm/share`, { contextGraphId: cg });

      expect(res.status, `agent share: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.swmShared).toBe(true);
      expect(res.body.sealed).toBe(true);
      expect(res.body.publishReady).toBe(true);
      const descriptor = await agent.get(
        `/api/knowledge-assets/${name}?contextGraphId=${cg}&agentAddress=${agent.agentAddress}`,
      );
      expect(descriptor.status, `agent descriptor: ${JSON.stringify(descriptor.body)}`).toBe(200);
      expect(descriptor.body.status).toBe('swm-shared');
      expect(String(descriptor.body.agentAddress).toLowerCase()).toBe(agent.agentAddress.toLowerCase());
      expect(String(descriptor.body.reservedUal).toLowerCase()).toContain(agent.agentAddress.toLowerCase());
    });

    // #1116 — the route's thin wrapper over the seal-by-default share contract.
    // The B1/B2 agent e2e tests pin the ENGINE outcomes; these pin the ROUTE's
    // strict-boolean validation + the seal-outcome fields it forwards (sealed /
    // publishReady) so the HTTP surface can't silently drift from the engine.
    describe('#1116 seal-outcome contract', () => {
      it('strict-boolean: skipSeal:"false" (a string) → 400 "must be a boolean"', async () => {
        // The validator runs BEFORE promote, so no finalized draft is needed; a
        // stray string must 400 rather than silently flip the seal-by-default.
        const res = await postJson(daemon, '/api/knowledge-assets/share/swm/share', {
          contextGraphId: REG,
          skipSeal: 'false',
        });
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toMatch(/"skipSeal" must be a boolean/);
      });

      it('a bare FULL share (no skipSeal) → 200 sealed:true / publishReady:true', async () => {
        await createKa(REG, 'share-full-default');
        await write(REG, 'share-full-default', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
        const res = await postJson(daemon, '/api/knowledge-assets/share-full-default/swm/share', {
          contextGraphId: REG,
        });
        expect(res.status).toBe(200);
        expect(res.body.swmShared).toBe(true);
        expect(res.body.promotedCount).toBeGreaterThan(0);
        expect(res.body.sealed).toBe(true);
        expect(res.body.publishReady).toBe(true);
      });

      it('a skipSeal:true full share is rejected before SWM mutation', async () => {
        await createKa(REG, 'share-skip-seal');
        await write(REG, 'share-skip-seal', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
        const res = await postJson(daemon, '/api/knowledge-assets/share-skip-seal/swm/share', {
          contextGraphId: REG,
          skipSeal: true,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('UNSEALED_SHARE_UNSUPPORTED');
      });

      it('rejects root-entity selection before SWM mutation', async () => {
        await createKa(REG, 'share-subset-rejected');
        await write(REG, 'share-subset-rejected', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
        const res = await postJson(daemon, '/api/knowledge-assets/share-subset-rejected/swm/share', {
          contextGraphId: REG,
          entities: ['ex:A'],
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('KA_ATOMIC_SHARE_REQUIRED');
      });

      // UNSEALED_SHARE_BLOCKED → 409: NOT covered here. It needs a residual
      // signing-capability gap (no local key / non-V10 chain) on a default full
      // share — the live daemon harness always HAS a signing key + a V10 chain,
      // so the gap can't be staged cleanly without faking the agent (which this
      // real-daemon suite deliberately avoids). The fail-closed + WM-preserved
      // path is covered at the engine level by the agent e2e tests
      // (packages/agent/test/e2e-memory-layers.test.ts, #1116 block) and the
      // route's own try/catch maps e.code==='UNSEALED_SHARE_BLOCKED' → 409.
    });

    // #1116 — the bare daemon route is a PRIMITIVE: create-with-quads seals only
    // (status 'wm-sealed') and does NOT auto-share. The "seal+share by default"
    // convenience lives in the combined CLIENT functions (mcp-dkg / openclaw
    // createKnowledgeAsset), which set alsoShareSwm:true for the caller — not in
    // this route. Auto-sharing here would conflict with memory-graph-events and
    // the "create stops at a sealed WM draft" invariant the agent-tooling relies
    // on. The opt-in alsoShareSwm:true path is asserted separately below.
    it('create one-shot {quads, finalize:true} stays SEAL-ONLY → wm-sealed, no auto-share', async () => {
      const res = await createKa(REG, 'oneshot-seal-only', {
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('wm-sealed');
      expect(res.body.swmShared).toBeUndefined();
    });

    it('create one-shot with explicit alsoShareSwm:true → swm-shared + sealed:true', async () => {
      const res = await createKa(REG, 'oneshot-explicit-share', {
        quads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }],
        finalize: true,
        alsoShareSwm: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('swm-shared');
      expect(res.body.swmShared).toBe(true);
      expect(res.body.sealed).toBe(true);
      expect(res.body.publishReady).toBe(true);
    });
  });

  // ── vm/publish: real preconditions + validation + failure mapping ──
  describe('vm/publish', () => {
    it('409 VM_PUBLISH_PRECONDITION when the assertion is not finalized', async () => {
      await createKa(REG, 'pub-nofin');
      await write(REG, 'pub-nofin', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      const res = await postJson(daemon, '/api/knowledge-assets/pub-nofin/vm/publish', { contextGraphId: REG });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VM_PUBLISH_PRECONDITION');
      expect(String(res.body.error)).toMatch(/not finalized/);
    });

    it('409 PUBLISH_NOT_FULL_SHARE when finalized but nothing shared into SWM', async () => {
      // #1116 (round 9): finalize-without-share leaves a seal but NO
      // swmShareComplete marker, so the marker gate (a publish requires a complete
      // full share resident in SWM) rejects FIRST with PUBLISH_NOT_FULL_SHARE,
      // mapped to 409 (same precondition family as the old "No quads in shared
      // memory" VM_PUBLISH_PRECONDITION — both are pre-chain caller preconditions).
      await createKa(PUBREG, 'pub-noshare');
      // A UNIQUE subject so a later cross-match can't accidentally share it.
      await write(PUBREG, 'pub-noshare', [{ subject: 'ex:noshare-only', predicate: 'ex:p', object: '"x"' }]);
      await postJson(daemon, '/api/knowledge-assets/pub-noshare/wm/finalize', { contextGraphId: PUBREG });
      const res = await postJson(daemon, '/api/knowledge-assets/pub-noshare/vm/publish', { contextGraphId: PUBREG });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PUBLISH_NOT_FULL_SHARE');
      expect(String(res.body.error)).toMatch(/complete full share/i);
    });

    it('rejects a non-integer epochs option (400, no publish)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/share/vm/publish', { contextGraphId: REG, options: { epochs: 'soon' } });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('"epochs"');
    });

    it('rejects epochs above the uint32 ceiling (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/share/vm/publish', { contextGraphId: REG, options: { epochs: 4294967296 } });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('4294967295');
    });

    it('rejects assertionName (the URL name selects the assertion) (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/share/vm/publish', { contextGraphId: REG, assertionName: 'other' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('assertionName');
    });

    it('rejects an author override (the seal encodes the author) (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/share/vm/publish', { contextGraphId: REG, authorAgentAddress: '0xdead' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/authorAgentAddress/);
    });

    it('rejects a pre-signed author override (the seal encodes the author) (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/share/vm/publish', {
        contextGraphId: REG,
        preSignedAuthorAttestation: {
          address: `0x${'11'.repeat(20)}`,
          reservedKaId: '1',
          signature: { r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` },
        },
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/preSignedAuthorAttestation/);
    });

    it('does NOT down-classify a genuine publisher failure: a real ACK-quorum miss stays 5xx', async () => {
      // A finalized+shared KA on an EDGE node cannot reach StorageACK quorum
      // (no connected core peers) → the real publisher throws and the route
      // surfaces it as a 5xx, never a misleading 2xx. (A confirmed MINT is the
      // devnet-tier case below.)
      await createKa(REG, 'pub-real');
      await write(REG, 'pub-real', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      await postJson(daemon, '/api/knowledge-assets/pub-real/wm/finalize', { contextGraphId: REG });
      await postJson(daemon, '/api/knowledge-assets/pub-real/swm/share', { contextGraphId: REG });
      const res = await postJson(daemon, '/api/knowledge-assets/pub-real/vm/publish', { contextGraphId: REG });
      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    // #1116 (round 5, FIX 3a): the /vm/publish auto-register branch. Publishing a
    // FINALIZED+SHARED KA on a created-but-UNregistered CG must transparently
    // register the CG on-chain (the deferred-registration step), NOT 400 with
    // "not registered on-chain". After the call the CG has a truthy on-chain id,
    // and the publish then fails ONLY at the edge-node ACK-quorum step (5xx,
    // "no connected core peers"), never the registration precondition. A
    // regression that drops the auto-register branch would 400 here instead.
    it('auto-registers an UNregistered CG at publish time, then fails only at ACK quorum (5xx, not "not registered")', async () => {
      // LOCAL_AUTOREG was created (beforeAll) but DELIBERATELY never registered
      // on-chain — and is used ONLY here, so auto-registering it pollutes nothing.
      await createKa(LOCAL_AUTOREG, 'pub-autoreg');
      // Unique subject so the SWM selection can't cross-match another KA's quad.
      await write(LOCAL_AUTOREG, 'pub-autoreg', [{ subject: 'ex:autoreg-only', predicate: 'ex:p', object: '"x"' }]);
      await postJson(daemon, '/api/knowledge-assets/pub-autoreg/wm/finalize', { contextGraphId: LOCAL_AUTOREG });
      await postJson(daemon, '/api/knowledge-assets/pub-autoreg/swm/share', { contextGraphId: LOCAL_AUTOREG });

      const res = await postJson(daemon, '/api/knowledge-assets/pub-autoreg/vm/publish', { contextGraphId: LOCAL_AUTOREG });

      // The auto-register branch fired: this is NOT the unregistered-CG 400 (nor
      // the "could not be auto-registered" 400) — it proceeded to the on-chain
      // publish and failed only at the edge-node ACK-quorum step (devnet-tier 5xx).
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(String(res.body?.error ?? '')).not.toMatch(/not registered on-chain/i);
      expect(String(res.body?.error ?? '')).not.toMatch(/could not be auto-registered/i);

      // And LOCAL_AUTOREG now carries a truthy on-chain id — registration happened.
      const list = await getJson(daemon, '/api/context-graph/list');
      const local = (list.body?.contextGraphs ?? []).find((c: any) => c.id === LOCAL_AUTOREG);
      expect(local, `LOCAL_AUTOREG CG descriptor: ${JSON.stringify(list.body)}`).toBeTruthy();
      const onChainId = local?.onChainId ?? local?.onChainContextGraphId;
      expect(onChainId, `expected a truthy on-chain id after auto-register, got ${JSON.stringify(local)}`).toBeTruthy();
    });

    // #1116 (round 6, FIX 2 gas-preflight): an UNregistered CG + a FINALIZED seal
    // + an EMPTY SWM (finalized but NEVER shared) must hit the no-quads precondition
    // BEFORE any registration tx — so the route does NOT auto-register (burning gas)
    // and then fail. This proves the engine's SWM-empty preflight runs ahead of the
    // publisher's CG_NOT_REGISTERED guard: the response is the no-quads precondition
    // (NOT "not registered on-chain"), and the CG stays UNregistered afterward.
    it('FIX 2 gas-preflight: unregistered CG + finalized but UNshared (empty SWM) returns no-quads WITHOUT registering', async () => {
      // LOCAL_NOSHARE was created off-chain (beforeAll), never registered.
      await createKa(LOCAL_NOSHARE, 'pub-noshare-unreg');
      // Unique subject so the seal's selection can't cross-match another KA's shared quad.
      await write(LOCAL_NOSHARE, 'pub-noshare-unreg', [{ subject: 'ex:noshare-unreg-only', predicate: 'ex:p', object: '"x"' }]);
      // FINALIZE (seals the WM draft) but DELIBERATELY do NOT swm/share → SWM stays empty.
      await postJson(daemon, '/api/knowledge-assets/pub-noshare-unreg/wm/finalize', { contextGraphId: LOCAL_NOSHARE });

      const res = await postJson(daemon, '/api/knowledge-assets/pub-noshare-unreg/vm/publish', { contextGraphId: LOCAL_NOSHARE });

      // #1116 (round 9): finalize-without-share leaves no swmShareComplete marker,
      // so the marker gate (PUBLISH_NOT_FULL_SHARE) fires as a pre-chain 4xx
      // precondition BEFORE any registration tx — proving the gate runs ahead of
      // the publisher's CG-not-registered guard (so no gas is burned).
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body?.code).toBe('PUBLISH_NOT_FULL_SHARE');
      expect(String(res.body?.error ?? '')).not.toMatch(/not registered on-chain/i);

      // And the CG is STILL unregistered — no registration tx was sent (no gas burned).
      const list = await getJson(daemon, '/api/context-graph/list');
      const cg = (list.body?.contextGraphs ?? []).find((c: any) => c.id === LOCAL_NOSHARE);
      expect(cg, `LOCAL_NOSHARE CG descriptor: ${JSON.stringify(list.body)}`).toBeTruthy();
      const onChainId = cg?.onChainId ?? cg?.onChainContextGraphId;
      expect(onChainId == null, `expected NO on-chain id (CG must stay unregistered), got ${JSON.stringify(cg)}`).toBe(true);
    });
  });

  // ── GET /:name descriptor ─────────────────────────────────────────
  describe('GET /api/knowledge-assets/:name', () => {
    it('returns lifecycle state for a freshly-created KA', async () => {
      await createKa(LOCAL, 'state');
      const { status, body } = await getJson(daemon, `/api/knowledge-assets/state?contextGraphId=${LOCAL}`);
      expect(status).toBe(200);
      expect(body.state).toBe('created');
      expect(body.memoryLayer).toBe('WM');
    });

    it('rejects a malformed agentAddress (400, before any read)', async () => {
      const { status, body } = await getJson(daemon, `/api/knowledge-assets/state?contextGraphId=${LOCAL}&agentAddress=not-an-address`);
      expect(status).toBe(400);
      expect(String(body.error)).toContain('agentAddress');
    });

    it('forwards an author-scoped agentAddress into the descriptor read (#988)', async () => {
      // The agentAddress query param scopes the read to that author. Proven
      // single-node: the owner's OWN address resolves the KA it authored; a
      // real but non-authoring address (a freshly-registered agent) 404s
      // instead of falling back to the owner — so the param is genuinely
      // forwarded, not ignored. (Cross-AUTHOR divergence — a KA authored by a
      // different on-chain identity — is devnet-tier: custodial agents on one
      // node all author under the node-owner address.)
      await createKa(LOCAL, 'scoped');
      // The canonical per-layer graph URI exposes a lowercase address while
      // historical lifecycle URNs preserve the writer's EIP-55 casing. Drive
      // the lowercase form explicitly so this remains a casing-compatibility
      // regression even if the create response changes its presentation.
      const canonicalOwnerAddress = ownerAddress.toLowerCase();
      const mine = await getJson(daemon, `/api/knowledge-assets/scoped?contextGraphId=${LOCAL}&agentAddress=${canonicalOwnerAddress}`);
      expect(mine.status, `owner-scoped descriptor: ${JSON.stringify(mine.body)}`).toBe(200);
      expect(String(mine.body.agentAddress).toLowerCase()).toBe(canonicalOwnerAddress);

      const reg = await postJson(daemon, '/api/agent/register', { name: 'ka-agent-b', framework: 'test' });
      const other = await getJson(daemon, `/api/knowledge-assets/scoped?contextGraphId=${LOCAL}&agentAddress=${reg.body.agentAddress}`);
      expect(other.status).toBe(404);
    });

    it('resolves a finalized rootless KA by its author-scoped UAL', async () => {
      const name = `rootless-ual-${Date.now().toString(36)}`;
      const created = await createKa(REG, name, {
        quads: [{ subject: 'ex:rootless-ual', predicate: 'ex:p', object: '"value"' }],
        finalize: true,
      });
      expect(created.status, `create+finalize: ${JSON.stringify(created.body)}`).toBe(201);

      const byName = await getJson(
        daemon,
        `/api/knowledge-assets/${encodeURIComponent(name)}?contextGraphId=${encodeURIComponent(REG)}`,
      );
      expect(byName.status, `name descriptor: ${JSON.stringify(byName.body)}`).toBe(200);
      const reservedUal = String(byName.body.reservedUal ?? '');
      expect(reservedUal).toMatch(/^did:dkg:[^/]+\/0x[0-9a-f]{40}\/[0-9]+$/);

      const byUal = await getJson(
        daemon,
        `/api/knowledge-assets/${encodeURIComponent(reservedUal)}?contextGraphId=${encodeURIComponent(REG)}`,
      );
      expect(byUal.status, `UAL descriptor: ${JSON.stringify(byUal.body)}`).toBe(200);
      expect(byUal.body.name).toBe(name);
      expect(String(byUal.body.reservedUal).toLowerCase()).toBe(reservedUal.toLowerCase());
    });

    it('agent-token reads and discards its own WM draft without an explicit agentAddress query param', async () => {
      const agent = await registerAgentClient('ka-token-lane-wm');
      const cg = `ka-token-lane-wm-${Date.now().toString(36)}`;
      const name = 'token-lane-draft';
      await createRegisteredAgentContextGraph(agent, cg);

      const writeRes = await agent.post(`/api/knowledge-assets/${name}/wm/write`, {
        contextGraphId: cg,
        quads: [{ subject: 'ex:token-lane', predicate: 'ex:p', object: '"token-lane"' }],
      });
      expect(writeRes.status, `write: ${JSON.stringify(writeRes.body)}`).toBe(200);

      const readRes = await agent.get(`/api/knowledge-assets/${name}/wm/quads?contextGraphId=${cg}`);
      expect(readRes.status, `read: ${JSON.stringify(readRes.body)}`).toBe(200);
      expect(readRes.body.count).toBe(1);
      expect(readRes.body.quads?.[0]?.subject).toBe('ex:token-lane');

      const discardRes = await agent.post(`/api/knowledge-assets/${name}/wm/discard`, { contextGraphId: cg });
      expect(discardRes.status, `discard: ${JSON.stringify(discardRes.body)}`).toBe(200);

      const afterDiscard = await agent.get(`/api/knowledge-assets/${name}/wm/quads?contextGraphId=${cg}`);
      expect(afterDiscard.status, `after discard: ${JSON.stringify(afterDiscard.body)}`).toBe(200);
      expect(afterDiscard.body.count).toBe(0);
    });
  });

  // ── wm/pull-from ──────────────────────────────────────────────────
  describe('wm/pull-from', () => {
    it('requires a valid layer (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/share/wm/pull-from', { contextGraphId: REG });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('layer');
    });

    it('GH #1094 (fixed): pull-from {layer:swm} re-opens the WM draft and re-seeds the sealed entities', async () => {
      // #1094 shipped (PR #1107): the route's sealed-entity lookup now spans the
      // per-KA SWM/VM graphs (…/_shared_memory|_verifiable_memory/{author}/{n})
      // and clears the stale seal when re-opening, so pull-from seeds the draft
      // instead of 500ing "No sealed entity list". This is the positive seeding
      // leg the prior red-while-live repro promised to flip to. `share` was
      // finalized + shared to SWM earlier in this suite, so pulling from SWM
      // re-opens its WM draft and re-seeds its one entity (ex:A).
      const res = await postJson(daemon, '/api/knowledge-assets/share/wm/pull-from', { contextGraphId: REG, layer: 'swm' });
      expect(res.status).toBe(200);
      expect(res.body.wmDraft).toBe('open');
      expect(res.body.seededFrom).toEqual({ layer: 'swm' });
      expect(res.body.fromLayer).toBe('swm');
      expect(typeof res.body.seeded).toBe('number');
      expect(res.body.seeded).toBeGreaterThanOrEqual(1);
      expect(res.body.seededPublic).toBeGreaterThanOrEqual(1);
    });

    it('agent-token pulls from its own SWM lane without an explicit agentAddress body field', async () => {
      const agent = await registerAgentClient('ka-token-lane-pull');
      const cg = `ka-token-lane-pull-${Date.now().toString(36)}`;
      const name = 'token-lane-pull';
      await createRegisteredAgentContextGraph(agent, cg);

      const writeRes = await agent.post(`/api/knowledge-assets/${name}/wm/write`, {
        contextGraphId: cg,
        quads: [{ subject: 'ex:token-pull', predicate: 'ex:p', object: '"token-pull"' }],
      });
      expect(writeRes.status, `write: ${JSON.stringify(writeRes.body)}`).toBe(200);

      const shareRes = await agent.post(`/api/knowledge-assets/${name}/swm/share`, {
        contextGraphId: cg,
      });
      expect(shareRes.status, `share: ${JSON.stringify(shareRes.body)}`).toBe(200);

      const pullRes = await agent.post(`/api/knowledge-assets/${name}/wm/pull-from`, {
        contextGraphId: cg,
        layer: 'swm',
        onConflict: 'replace',
      });
      expect(pullRes.status, `pull: ${JSON.stringify(pullRes.body)}`).toBe(200);
      expect(pullRes.body.seeded).toBeGreaterThan(0);

      const readRes = await agent.get(`/api/knowledge-assets/${name}/wm/quads?contextGraphId=${cg}`);
      expect(readRes.status, `read: ${JSON.stringify(readRes.body)}`).toBe(200);
      expect(readRes.body.count).toBeGreaterThan(0);
      expect(readRes.body.quads.some((q: any) => q.subject === 'ex:token-pull')).toBe(true);
    });
  });

  // ── import-file (real multipart upload + extraction) ──────────────
  describe('wm/import-file (real multipart)', () => {
    it('routes a markdown upload to the import handler and completes extraction', async () => {
      const res = await postMultipart(daemon, '/api/knowledge-assets/imp-done/wm/import-file', [
        { name: 'contextGraphId', value: LOCAL },
        { name: 'file', filename: 'doc.md', contentType: 'text/markdown', value: '# Title\n\nHello world body.\n' },
      ]);
      expect(res.status).toBe(200);
      // Real extraction wrote a real content-addressed blob.
      expect(String(res.body.fileHash)).toMatch(/^keccak256:/);
      // Observable proof the extraction populated the real store.
      const es = await getJson(daemon, `/api/knowledge-assets/imp-done/wm/extraction-status?contextGraphId=${LOCAL}`);
      expect(es.status).toBe(200);
      expect(es.body.status).toBe('completed');
    });

    it('replaces stale KA-scoped named graph draft content on same-name import', async () => {
      const name = `imp-replace-mixed-${Date.now().toString(36)}`;
      const namedGraph = 'urn:test:graph:stale-import-replace';
      const createRes = await createKa(LOCAL, name);
      expect([200, 201]).toContain(createRes.status);

      const writeRes = await write(LOCAL, name, [
        {
          subject: 'urn:test:entity:old-default',
          predicate: 'http://schema.org/name',
          object: '"Old Default"',
          graph: '',
        },
        {
          subject: 'urn:test:entity:old-named',
          predicate: 'http://schema.org/name',
          object: '"Old Named"',
          graph: namedGraph,
        },
      ]);
      expect(writeRes.status, `write: ${JSON.stringify(writeRes.body)}`).toBe(200);

      const before = await wmQuads(LOCAL, name);
      expect(before.status, `before query: ${JSON.stringify(before.body)}`).toBe(200);
      expect(before.body.quads).toEqual(expect.arrayContaining([
        expect.objectContaining({ subject: 'urn:test:entity:old-named', graph: namedGraph }),
      ]));

      const res = await postMultipart(daemon, `/api/knowledge-assets/${name}/wm/import-file`, [
        { name: 'contextGraphId', value: LOCAL },
        { name: 'file', filename: 'replacement.md', contentType: 'text/markdown', value: '# Replacement\n\nFresh body.\n' },
      ]);
      expect(res.status, `import-file: ${JSON.stringify(res.body)}`).toBe(200);

      const after = await wmQuads(LOCAL, name);
      expect(after.status, `after query: ${JSON.stringify(after.body)}`).toBe(200);
      expect(after.body.quads.some((q: any) => q.subject === 'urn:test:entity:old-default')).toBe(false);
      expect(after.body.quads.some((q: any) => q.subject === 'urn:test:entity:old-named')).toBe(false);
      expect(after.body.quads.some((q: any) => q.graph === namedGraph)).toBe(false);
    });

    it('returns the import-file-specific 400 when the file part is missing (not JSON-parsed)', async () => {
      const res = await postMultipart(daemon, '/api/knowledge-assets/imp-nofile/wm/import-file', [
        { name: 'contextGraphId', value: LOCAL },
      ]);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/file/i);
    });

    it('returns 400 when the request is not multipart/form-data', async () => {
      const res = await fetch(`${daemon.base}/api/knowledge-assets/imp-nonmp/wm/import-file`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'text/plain' },
        body: 'not-multipart',
      });
      expect(res.status).toBe(400);
      expect((await res.text())).toMatch(/multipart/);
    });
  });

  // ── extraction-status / import-artifact / semantic-enrichment ─────
  describe('imported-artifact surface (seeded by a real import)', () => {
    let assertionUri = '';

    beforeAll(async () => {
      const imp = await postMultipart(daemon, '/api/knowledge-assets/artifact/wm/import-file', [
        { name: 'contextGraphId', value: LOCAL },
        { name: 'file', filename: 'a.md', contentType: 'text/markdown', value: '# Imported\n\nArtifact body.\n' },
      ]);
      expect(imp.status).toBe(200);
      assertionUri = imp.body.assertionUri;
      expect(assertionUri).toMatch(/^did:dkg:/);
    });

    it('extraction-status returns 404 for a never-imported assertion', async () => {
      const res = await getJson(daemon, `/api/knowledge-assets/never-imported/wm/extraction-status?contextGraphId=${LOCAL}`);
      expect(res.status).toBe(404);
    });

    it('import-artifact/resolve resolves the completed artifact from real graph metadata', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/import-artifact/resolve', { contextGraphId: LOCAL, assertionUri });
      expect(res.status).toBe(200);
      expect(res.body.artifact.assertionName).toBe('artifact');
      expect(String(res.body.artifact.assertionAgentAddress).toLowerCase()).toBe(ownerAddress.toLowerCase());
    });

    it('import-artifact/resolve rejects a missing assertionUri (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/import-artifact/resolve', { contextGraphId: LOCAL });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('assertionUri');
    });

    it('import-artifact/read-markdown reads the real stored bytes', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/import-artifact/read-markdown', { contextGraphId: LOCAL, assertionUri });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('Imported');
    });

    it('semantic-enrichment/write appends model triples with provenance', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/semantic-enrichment/write', {
        contextGraphId: LOCAL,
        assertionUri,
        semanticQuads: [{ subject: 'urn:e:1', predicate: 'http://schema.org/about', object: 'urn:topic:x' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.assertionName).toBe('artifact');
    });

    it('semantic-enrichment/write rejects a target assertion name override (400)', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/semantic-enrichment/write', {
        contextGraphId: LOCAL,
        assertionUri,
        name: 'somewhere-else',
        semanticQuads: [{ subject: 'a', predicate: 'b', object: 'c' }],
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('target assertion names are not supported');
    });
  });

  // ── async swm/share queue ─────────────────────────────────────────
  describe('swm/share-async queue', () => {
    it('enqueues a real job → { jobId, state: "queued" }', async () => {
      await createKa(LOCAL, 'async');
      await write(LOCAL, 'async', [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"' }]);
      const res = await postJson(daemon, '/api/knowledge-assets/async/swm/share-async', { contextGraphId: LOCAL });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('queued');
      expect(res.body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects root-entity selection instead of enqueueing a partial KA', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/async/swm/share-async', {
        contextGraphId: LOCAL,
        entities: ['ex:A'],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('KA_ATOMIC_SHARE_REQUIRED');
    });

    it('GET swm/share-jobs returns a jobs array', async () => {
      const res = await getJson(daemon, `/api/knowledge-assets/swm/share-jobs?contextGraphId=${LOCAL}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it('GET swm/share-jobs/:jobId returns 404 for an unknown job', async () => {
      const res = await getJson(daemon, `/api/knowledge-assets/swm/share-jobs/does-not-exist-123?contextGraphId=${LOCAL}`);
      expect(res.status).toBe(404);
      expect(String(res.body.error)).toMatch(/not found/i);
    });
  });

  // ── routing scope ─────────────────────────────────────────────────
  it('does not capture a sibling /api/assertion/* path (real router scoping)', async () => {
    // The KA handler scopes itself to its prefix; a sibling prefix is NOT
    // KA-shaped — the real router returns its own response (a 404 here),
    // never a knowledge-assets body.
    const res = await fetch(`${daemon.base}/api/assertion/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  // ── POST /api/knowledge-assets/publish — retired direct publish surface ──
  describe('POST /api/knowledge-assets/publish (removed)', () => {
    it('returns a clear 404 pointing callers at the named KA lifecycle', async () => {
      const res = await postJson(daemon, '/api/knowledge-assets/publish', {
        contextGraphId: LOCAL,
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: '' }],
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('DIRECT_PUBLISH_ROUTE_REMOVED');
      expect(String(res.body.error)).toContain('/api/knowledge-assets/:name/vm/publish');
    });
  });
});

// NOT COVERED HERE (test-only PR — no source `export` added): the
// classifyVmPublish (207 partial / 502 tentative-or-failed) and
// respondAssertionError (409 AssertionNotPersisted / payload-too-large)
// outcome-mapping branches depend on a publisher RESULT shape or a specific
// engine error class a single happy edge node can't manufacture; the
// functions are module-private, so unit-testing them would require an
// `export` (a source change). The REACHABLE 400/409 branches are covered
// via the live daemon above; the rest are documented devnet-tier below.

/**
 * DEVNET-TIER (not single-edge-daemon): these need real cross-node behaviour a
 * single edge daemon cannot provide, and live in devnet/issue-liveness instead:
 *   - vm/publish CONFIRMED mint/update on chain (needs StorageACK quorum from
 *     ≥3 core peers — an edge node 500s "no connected core peers").
 *   - OT-RFC-43 A2/B3 per-layer pointer divergence + kaId/UAL addressing of a
 *     genuinely minted KA (needs a real on-chain kaNumber + reservedUal).
 *   - async-promote job state transitions (queued→running→succeeded, recover-
 *     409) — needs the promote worker process advancing the queue.
 *   - wm/pull-from happy path + WM_DRAFT_CONFLICT 409 — blocked by GH #1094.
 */
