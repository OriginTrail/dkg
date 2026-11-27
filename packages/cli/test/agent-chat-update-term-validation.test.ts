/**
 * `POST /api/update` validates every term of `quads` and `privateQuads`
 * before the agent runs the update: a term the RDF grammar does not allow is
 * a 400, and the agent is never called.
 */
import { describe, expect, it } from 'vitest';
import {
  SPARQL_TERM_VALIDATION_ERROR_CODE,
  SparqlTermValidationError,
  USER_AUTHORED_TRUST_LEVEL_CODE,
  UserAuthoredTrustLevelError,
} from '@origintrail-official/dkg-core';
import { respondWithDaemonError } from '../src/daemon/http-utils.js';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const AGENT_STOPPED = 'fake agent: update reached';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

async function postUpdate(
  body: Record<string, unknown>,
  agentError: () => Error = () => new Error(AGENT_STOPPED),
) {
  const calls: unknown[][] = [];
  const agent = {
    async update(...args: unknown[]) {
      calls.push(args);
      throw agentError();
    },
  };
  const tracker = {
    start() {},
    phaseCallback() { return () => {}; },
    fail() {},
  };
  const path = '/api/update';
  const res = fakeRes();
  const ctx = {
    req: {
      method: 'POST',
      url: path,
      headers: {},
      __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
    },
    res,
    agent,
    tracker,
    path,
    url: new URL(`http://127.0.0.1${path}`),
    validTokens: new Set<string>(),
    requestAgentAddress: '',
    authentication: requestAuthentication({ kind: 'nodeOperator' }),
  } as unknown as RequestContext;
  let thrown: unknown;
  try {
    await handleAgentChatRoutes(ctx);
  } catch (error) {
    thrown = error;
  }
  return {
    status: res.statusCode as number,
    body: res.body ? JSON.parse(res.body) as Record<string, unknown> : undefined,
    agentCalls: calls.length,
    thrown,
  };
}

const WELL_FORMED = { subject: 'urn:update:root', predicate: 'http://schema.org/name', object: '"kept"@en-GB' };

describe('POST /api/update term validation', () => {
  it('passes well-formed quads and private quads to the agent (control)', async () => {
    const result = await postUpdate({
      kaId: '1',
      contextGraphId: 'term-validation-cg',
      quads: [WELL_FORMED],
      privateQuads: [WELL_FORMED],
    });
    expect(result.agentCalls).toBe(1);
    expect(result.thrown).toBeInstanceOf(Error);
    expect((result.thrown as Error).message).toBe(AGENT_STOPPED);
  });

  it.each([
    ['quads', 'a language tag with a character a tag may not hold', '"refused value"@en_GB'],
    ['quads', 'a blank-node label with a character a label may not hold', '_:node!refused'],
    ['privateQuads', 'a language tag with a character a tag may not hold', '"refused value"@en_GB'],
    ['privateQuads', 'a blank-node label with a character a label may not hold', '_:node!refused'],
  ])('answers 400 for %s carrying %s, before the agent runs', async (field, _label, object) => {
    const result = await postUpdate({
      kaId: '1',
      contextGraphId: 'term-validation-cg',
      quads: [WELL_FORMED],
      [field]: [WELL_FORMED, { ...WELL_FORMED, object }],
    });
    expect(result.thrown).toBeUndefined();
    expect(result.status).toBe(400);
    expect(String(result.body?.error)).toContain(`"${field}[1].object"`);
    expect(result.agentCalls).toBe(0);
  });

  it.each([
    ['quads', { quads: 'not-an-array' }],
    ['privateQuads', { quads: [WELL_FORMED], privateQuads: { subject: 'urn:update:root' } }],
  ])('keeps the 400 for a non-array "%s"', async (field, fields) => {
    const result = await postUpdate({ kaId: '1', contextGraphId: 'term-validation-cg', ...fields });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe(`"${field}" must be an array when provided`);
    expect(result.agentCalls).toBe(0);
  });

  it('answers 400 for a string-shaped quad, before the agent runs', async () => {
    const result = await postUpdate({
      kaId: '1',
      contextGraphId: 'term-validation-cg',
      quads: ['<urn:update:root> <http://schema.org/name> "kept" .'],
    });
    expect(result.status).toBe(400);
    expect(String(result.body?.error)).toContain('string-shaped quads are not accepted');
    expect(result.agentCalls).toBe(0);
  });

  it.each([
    ['in process', () => new SparqlTermValidationError('sparql-http.insert: invalid literal in SPARQL object position', 'literal')],
    ['from the store worker', () => Object.assign(new Error('oxigraph.insert: invalid literal in SPARQL object position'), {
      name: 'SparqlTermValidationError',
      code: SPARQL_TERM_VALIDATION_ERROR_CODE,
    })],
  ])('maps a term the store refuses %s to a 400, not a 500', async (_where, agentError) => {
    const result = await postUpdate({
      kaId: '1',
      contextGraphId: 'term-validation-cg',
      quads: [WELL_FORMED],
    }, agentError);
    expect(result.agentCalls).toBe(1);
    // The route rethrows; the daemon's top-level handler maps the error.
    const res = fakeRes();
    respondWithDaemonError(res, result.thrown);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: expect.stringContaining('invalid literal'),
      code: SPARQL_TERM_VALIDATION_ERROR_CODE,
    });
  });

  it('maps user-authored trust metadata the agent refuses to a 400, not a 500', async () => {
    const result = await postUpdate({
      kaId: '1',
      contextGraphId: 'term-validation-cg',
      quads: [{ ...WELL_FORMED, predicate: '<http://dkg.io/ontology/trustLevel>' }],
    }, () => new UserAuthoredTrustLevelError('urn:update:root'));
    expect(result.agentCalls).toBe(1);
    const res = fakeRes();
    respondWithDaemonError(res, result.thrown);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: USER_AUTHORED_TRUST_LEVEL_CODE });
  });
});
