/**
 * Trust endpoint input validation (/api/verify, /api/endorse) — REAL daemon,
 * NO mocks.
 *
 * The retired version called `handleQueryRoutes` with a hand-built ctx whose
 * `agent.verify`/`agent.endorse` were vitest-mock tripwires that threw "should
 * not be reached", asserting the route rejected unsafe input BEFORE the agent.
 * The tripwire only proves "not reached" against a fake agent — it can't notice
 * if the real route stopped validating and started 500-ing or actually
 * dispatching.
 *
 * This version sends the same malicious bodies to a REAL edge daemon: a
 * SPARQL-injection contextGraphId / UAL and an oversized timeoutMs must each
 * come back as a real 400 from the real validator, before any trust operation
 * runs. (A real daemon has no agent stub to spy on — the 400-at-validation IS
 * the proof that the injection never reaches the engine.) Runs in the standard
 * cli lane against the shared Hardhat node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

const VERIFY_COLLECTION_TIMEOUT_MAX_MS = 30 * 60 * 1000;
const INJECTION = 'cg> } INSERT DATA { ?s ?p ?o } #';

describe('trust endpoint input validation (real daemon)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    daemon = await startLiveDaemon();
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('/api/verify rejects an unsafe contextGraphId with 400', async () => {
    const { status, body } = await postJson(daemon, '/api/verify', {
      contextGraphId: INJECTION,
      verifiableMemoryId: '1',
      batchId: '1',
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/contextGraphId|context graph ID|disallowed|safe/i);
  });

  it('/api/endorse rejects an unsafe contextGraphId with 400', async () => {
    const { status, body } = await postJson(daemon, '/api/endorse', {
      contextGraphId: INJECTION,
      ual: 'did:dkg:asset:1',
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/contextGraphId|context graph ID|disallowed|safe/i);
  });

  it('/api/endorse rejects an unsafe UAL with 400', async () => {
    const { status, body } = await postJson(daemon, '/api/endorse', {
      contextGraphId: 'cg-safe',
      ual: 'did:dkg:asset:1> } INSERT DATA { ?s ?p ?o } #',
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/ual|safe IRI/i);
  });

  it('/api/verify rejects an oversized timeoutMs with 400', async () => {
    const { status, body } = await postJson(daemon, '/api/verify', {
      contextGraphId: 'cg-safe',
      verifiableMemoryId: '1',
      batchId: '1',
      timeoutMs: VERIFY_COLLECTION_TIMEOUT_MAX_MS + 1,
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/timeoutMs/);
  });
});
