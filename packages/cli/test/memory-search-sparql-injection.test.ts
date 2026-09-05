import { describe, it, expect } from 'vitest';
import { escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string> };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, body: unknown) {
  return {
    method,
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

function buildCtx(body: unknown, captureSparql: (s: string) => void) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/memory/search');
  const agent = {
    store: {
      query: async (sparql: string) => {
        captureSparql(sparql);
        return { type: 'bindings' as const, bindings: [] };
      },
    },
  };
  const ctx = {
    req: fakeReq('POST', body),
    res,
    agent,
    // Force the vector fan-out to be skipped so we only exercise the SPARQL path.
    embeddingProvider: null,
    vectorStore: { search: async () => [] },
    path: url.pathname,
    url,
    authentication: requestAuthentication({ kind: 'anonymous' }),
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('POST /api/memory/search — SPARQL injection regression (PR #849)', () => {
  // Regression for the high-severity finding fixed in 1d02e55d's parent commit:
  // memory.ts used to escape via `query.replace(/"/g, '\\"').toLowerCase()`,
  // which left raw backslashes intact — a malicious `\"` payload would escape
  // the SPARQL literal's closing quote and break out of the literal context.
  //
  // The fix routes the query through `escapeSparqlLiteral`, which escapes
  // backslashes, double-quotes, CR, LF, and TAB per the SPARQL grammar.
  // These tests pin that contract at the route level so a future refactor
  // that reverts to quote-only escaping fails CI.

  it('routes special-character queries through escapeSparqlLiteral before interpolation', async () => {
    // Real backslash, real double-quote, real newline, real tab — the four
    // characters that a quote-only escape leaves dangerous.
    const rawQuery = 'hello\\world"\nfoo\tbar';
    let capturedSparql = '';
    const { ctx, res } = buildCtx(
      { query: rawQuery, contextGraphId: 'test-cg' },
      (s) => { capturedSparql = s; },
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(capturedSparql).not.toBe('');

    // The route lower-cases first, then escapes — pin both behaviors.
    const expectedEscaped = escapeSparqlLiteral(rawQuery.toLowerCase());
    expect(capturedSparql).toContain(`"${expectedEscaped}"`);

    // Verify the dangerous chars survived as their SPARQL escape sequences
    // (not the raw chars that would break out of the literal).
    expect(expectedEscaped).toContain('\\\\');   // backslash → \\
    expect(expectedEscaped).toContain('\\"');    // dquote   → \"
    expect(expectedEscaped).toContain('\\n');    // LF       → \n
    expect(expectedEscaped).toContain('\\t');    // TAB      → \t
  });

  it('refuses to produce a SPARQL string vulnerable to the legacy quote-only escape', async () => {
    // The exact breakout payload the legacy escape failed against:
    // `\"` after the prefix would, with quote-only escaping, become
    // `\\"` — the backslash escapes the closing quote, allowing the
    // attacker to inject SPARQL after the literal.
    const breakoutPayload = 'safe\\"; DROP GRAPH <urn:victim> ; #';
    let capturedSparql = '';
    const { ctx, res } = buildCtx(
      { query: breakoutPayload, contextGraphId: 'test-cg' },
      (s) => { capturedSparql = s; },
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);

    // What the legacy buggy path would have produced.
    const legacyBuggyOutput = breakoutPayload.toLowerCase().replace(/"/g, '\\"');
    // What the current safe path produces.
    const safeOutput = escapeSparqlLiteral(breakoutPayload.toLowerCase());

    // The safe form must be present; the buggy form must NOT appear inside
    // any string-literal pair. Pin the wrapping quotes around the safe form,
    // and assert the buggy form does not appear in that exact `"..."`
    // context. (The buggy form is a strict prefix of the safe form, so the
    // wrapping-quote pin is what makes the negative assertion meaningful.)
    expect(capturedSparql).toContain(`"${safeOutput}"`);
    expect(capturedSparql).not.toContain(`"${legacyBuggyOutput}"`);
    // The safe and buggy escapes MUST differ — if they didn't, the route
    // would have regressed to quote-only escaping.
    expect(safeOutput).not.toBe(legacyBuggyOutput);
  });

  it('preserves unicode payloads verbatim (no double-escape, no mojibake)', async () => {
    const unicodeQuery = 'café ☕ привет';
    let capturedSparql = '';
    const { ctx, res } = buildCtx(
      { query: unicodeQuery, contextGraphId: 'test-cg' },
      (s) => { capturedSparql = s; },
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(capturedSparql).toContain(`"${unicodeQuery.toLowerCase()}"`);
  });
});
