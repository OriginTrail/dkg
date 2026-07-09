// KC→KA rename guard — POST /api/update response + precondition contract.
//
// NO MOCKS. `/api/update` (agent-chat.ts) is the HTTP surface for Knowledge
// Asset updates. These tests drive the REAL route inside a REAL edge daemon
// (startLiveDaemon, booted against the shared Hardhat node) over true HTTP —
// no hand-built RequestContext, no fabricated agent stub returning canned data
// (which silently drifts from the real publisher).
//
// What a single edge daemon CAN prove for real (and does, below):
//   - the kaId input guards: missing / non-integer / "0" / negative kaId are
//     all rejected with 400 BEFORE the agent acts (route lines 963-986);
//   - the off-band update-attestation preconditions, all surfaced as a proper
//     4xx (not a generic 500): a MISSING `precomputedUpdateAttestation` → 422,
//     a structurally-MALFORMED one → 400, and a present-but-WRONG-merkleRoot
//     seal → 422 (the daemon recomputes the new root from the real KA state
//     and compares — a deterministic, real-crypto check).
//
// What is DEVNET-TIER (needs real core peers, documented — NOT faked here):
//   - the confirmed-update happy path (`status:'confirmed'`, a positive
//     decimal `kaId` string, `kas[]` from the on-chain manifest, `txHash`).
//     Reaching it requires a VALID UpdateAuthorAttestation seal AND on-chain
//     mint + StorageACK quorum from connected core peers — an edge daemon has
//     neither, so the response-shape contract (`String(result.kaId)` must be a
//     positive integer string, bigint forwarded to the agent) is exercised in
//     the devnet suite, not here.
//   - the "a genuine non-attestation fault is NOT masked as 422" guard. On a
//     single edge daemon EVERY error reachable from /api/update carries the
//     `precomputedUpdateAttestation` substring (missing/wrong-root → 422,
//     malformed → 400), so a non-attestation runtime fault can only be
//     provoked PAST a valid seal — i.e. at the ACK/mint stage, which is
//     devnet-tier. The route's catch (lines 1044-1050) only remaps messages
//     containing that substring; that branch logic is covered by the 422 +
//     400 cases proving the route reaches and classifies the agent's errors.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startLiveDaemon,
  stopLiveDaemon,
  postJson,
  type LiveDaemon,
} from './helpers/live-daemon.js';

const QUADS = [{ subject: 'urn:root', predicate: 'http://schema.org/name', object: '"v2"' }];
// A syntactically-valid 32-byte hex used to build a structurally-valid seal.
const HEX32 = '0x' + '11'.repeat(32);

async function postJsonAsAgent(daemon: LiveDaemon, authToken: string, path: string, body: unknown) {
  const res = await fetch(`${daemon.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function registerAgentClient(daemon: LiveDaemon, label: string) {
  const registered = await postJson(daemon, '/api/agent/register', {
    name: `${label}-${Date.now().toString(36)}`,
    framework: 'test',
  });
  expect(registered.status, `${label} register: ${JSON.stringify(registered.body)}`).toBeLessThan(300);
  const agentAddress = String(registered.body.agentAddress);
  const authToken = String(registered.body.authToken);
  expect(agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(authToken.length).toBeGreaterThan(0);
  return {
    agentAddress,
    authToken,
    post: (path: string, body: unknown) => postJsonAsAgent(daemon, authToken, path, body),
  };
}

async function getUpdateOperationsSince(daemon: LiveDaemon, from: number) {
  const res = await fetch(`${daemon.base}/api/operations?name=update&from=${from}&limit=10`);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

describe('POST /api/update — kaId + attestation contract (KC→KA), real daemon', () => {
  let daemon: LiveDaemon;
  const CG = 'update-contract-cg';

  beforeAll(async () => {
    daemon = await startLiveDaemon({ authEnabled: false });
    // A real local context graph for the update target. (The kaId guards and
    // the attestation preconditions fire before any CG lookup, but a real CG
    // keeps the requests realistic.)
    const created = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG });
    expect(created.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('rejects a missing kaId with 400 before the agent acts', async () => {
    const res = await postJson(daemon, '/api/update', { contextGraphId: CG, quads: QUADS });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing "kaId"/);
  });

  it('rejects a non-integer kaId with 400 before the agent acts', async () => {
    const res = await postJson(daemon, '/api/update', { kaId: 'not-a-number', contextGraphId: CG, quads: QUADS });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid "kaId"/);
  });

  it('rejects the parseable-but-invalid kaId "0" with 400 before the agent acts', async () => {
    // "0" is a TRUTHY string (slips past `!kaId`) and `BigInt("0") === 0n`
    // parses fine — without the explicit positivity guard the route would
    // forward 0n to agent.update and only fail with a cryptic on-chain revert.
    const res = await postJson(daemon, '/api/update', { kaId: '0', contextGraphId: CG, quads: QUADS });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid "kaId"/);
  });

  it('rejects a negative kaId with 400 before the agent acts', async () => {
    // `BigInt("-1") === -1n` also parses; a negative decimal must not leak
    // through to the agent / on-chain encoder.
    const res = await postJson(daemon, '/api/update', { kaId: '-1', contextGraphId: CG, quads: QUADS });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid "kaId"/);
  });

  it('rejects a structurally-malformed precomputedUpdateAttestation with 400', async () => {
    // parsePrecomputedUpdateAttestation validates the seal SHAPE at the HTTP
    // boundary (before the agent acts); a malformed object is a 400, distinct
    // from the 422 "precondition unmet" cases below.
    const res = await postJson(daemon, '/api/update', {
      kaId: '7',
      contextGraphId: CG,
      quads: QUADS,
      precomputedUpdateAttestation: { authorAddress: 'nope' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/precomputedUpdateAttestation.*requires/);
  });

  it('rejects a null precomputedUpdateAttestation with 400', async () => {
    const from = Date.now() - 1;
    const res = await postJson(daemon, '/api/update', {
      kaId: '7',
      contextGraphId: CG,
      quads: QUADS,
      precomputedUpdateAttestation: null,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/precomputedUpdateAttestation.*object/);
    const operations = await getUpdateOperationsSince(daemon, from);
    expect(operations.status).toBe(200);
    expect(operations.body.total).toBe(0);
  });

  it('rejects an agent token with another agent update attestation before update', async () => {
    const agentA = await registerAgentClient(daemon, 'update-author-a');
    const agentB = await registerAgentClient(daemon, 'update-author-b');
    const seal = {
      authorAddress: agentB.agentAddress,
      expectedNewMerkleRoot: HEX32,
      signature: { r: HEX32, vs: HEX32 },
    };

    const res = await agentA.post('/api/update', {
      kaId: '7',
      contextGraphId: CG,
      quads: QUADS,
      precomputedUpdateAttestation: seal,
    });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain(agentA.agentAddress);
    expect(String(res.body.error)).toContain(agentB.agentAddress);
    expect(String(res.body.error)).toContain('precomputedUpdateAttestation.authorAddress');
  });

  it('allows an agent token with a mixed-case self update attestation through the guard', async () => {
    const agent = await registerAgentClient(daemon, 'update-author-case');
    const mixedCaseAgent = `0x${agent.agentAddress.slice(2).toUpperCase()}`;
    expect(mixedCaseAgent).not.toBe(agent.agentAddress);
    const seal = {
      authorAddress: mixedCaseAgent,
      expectedNewMerkleRoot: HEX32,
      signature: { r: HEX32, vs: HEX32 },
    };

    const res = await agent.post('/api/update', {
      kaId: '7',
      contextGraphId: CG,
      quads: QUADS,
      precomputedUpdateAttestation: seal,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/expectedNewMerkleRoot mismatch/);
  });

  it('maps a missing precomputedUpdateAttestation precondition to 422, not 500', async () => {
    // An on-chain update requires an off-band UpdateAuthorAttestation seal;
    // when it's absent the publisher throws a plain Error mentioning
    // `precomputedUpdateAttestation`. That is a CALLER precondition failure,
    // so the route surfaces a 422 (Unprocessable Entity) rather than letting
    // it bubble to the generic 500 handler. The real daemon confirms the
    // precondition fires first — before any KA/CG lookup or chain call.
    const res = await postJson(daemon, '/api/update', { kaId: '7', contextGraphId: CG, quads: QUADS });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/precomputedUpdateAttestation/);
  });

  it('maps an expectedNewMerkleRoot mismatch in the seal to 422 (real recompute guard)', async () => {
    // A present, structurally-valid seal whose expectedNewMerkleRoot does not
    // match the root the daemon recomputes from the real KA state is a caller
    // precondition failure too. The recompute is real crypto: for a fresh
    // (empty) KA the daemon yields a deterministic root that cannot equal the
    // 0x1111… placeholder, so the seal is rejected with a 422 mismatch — never
    // a 500, and never a silent accept of a stale seal.
    const seal = {
      authorAddress: '0x' + '22'.repeat(20),
      expectedNewMerkleRoot: HEX32,
      signature: { r: HEX32, vs: HEX32 },
    };
    const res = await postJson(daemon, '/api/update', {
      kaId: '7',
      contextGraphId: CG,
      quads: QUADS,
      precomputedUpdateAttestation: seal,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/expectedNewMerkleRoot mismatch/);
  });
});
