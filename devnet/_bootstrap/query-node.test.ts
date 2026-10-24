/**
 * `queryNode` reads a SELECT answer through the shared `select-response.ts`. This proves,
 * without a devnet, that doing so changed nothing that any suite can see: for a generated
 * corpus of /api/query answers (every mix of the three envelopes, with values that are
 * arrays, nullish, non-arrays, non-objects and junk rows) and of non-200 replies, the real
 * `queryNode` (driven through a stubbed `fetch`) and a FROZEN COPY of its body from before
 * the extraction must agree on whether the call resolves or rejects, on the value it
 * returns, and on the class and the whole message of the error it throws.
 *
 * The frozen copy below is the old body verbatim, from the status check on. Do not edit it
 * to follow `queryNode`: a change to what `queryNode` accepts or says is a change for every
 * suite that calls it, and this test is what says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryNode, type DevnetNode } from './harness.js';

const node = { num: 7, apiPort: 9207, authToken: '' } as DevnetNode;

/** The body of `queryNode` before it delegated to select-response.ts, frozen. */
function frozenQueryNodeBody(status: number, json: any): unknown {
  if (status !== 200) {
    throw new Error(`query on node${node.num} failed (${status}): ${JSON.stringify(json)}`);
  }
  const bindings =
    json?.result?.bindings ?? // current daemon shape
    json?.results?.bindings ?? // SPARQL 1.1 JSON
    json?.bindings; // legacy flat
  if (!Array.isArray(bindings)) {
    throw new Error(
      `unrecognised /api/query response shape on node${node.num}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return bindings as Array<Record<string, unknown>>;
}

/** What a call did: the value it returned, or the class and message of what it threw. */
type Outcome = { readonly returned: unknown } | { readonly threw: { readonly name: string; readonly isPlainError: boolean; readonly message: string } };

function outcomeOf(run: () => unknown): Promise<Outcome> | Outcome {
  try {
    const value = run();
    if (value instanceof Promise) {
      return value.then(
        (returned): Outcome => ({ returned }),
        (error: unknown): Outcome => ({ threw: describeError(error) }),
      );
    }
    return { returned: value };
  } catch (error) {
    return { threw: describeError(error) };
  }
}

function describeError(error: unknown): { name: string; isPlainError: boolean; message: string } {
  return {
    name: error instanceof Error ? error.name : typeof error,
    isPlainError: error !== null && typeof error === 'object' && Object.getPrototypeOf(error) === Error.prototype,
    message: error instanceof Error ? error.message : String(error),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Serve `body` with `status` to the next fetch, and run the real `queryNode` against it. */
async function realQueryNode(status: number, body: string): Promise<Outcome> {
  vi.stubGlobal('fetch', async () => new Response(body, { status }));
  return outcomeOf(() => queryNode(node, 'SELECT ?p ?o WHERE { ?s ?p ?o }', { contextGraphId: 'devnet-test', view: 'verifiable-memory' }));
}

/** The frozen body on what the real call parses out of `body` (a body that is not JSON reads as null, as `postJson` does). */
function frozenOutcome(status: number, body: string): Outcome {
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* non-JSON */
  }
  return outcomeOf(() => frozenQueryNodeBody(status, json)) as Outcome;
}

const ABSENT = Symbol('absent');
const ROWS = [
  { p: '<urn:a>', o: '"1"' },
  { p: { value: 'urn:b', type: 'uri' }, o: { value: 'x', datatype: 'urn:dt', 'xml:lang': 'en', extra: 1 } },
];
const BINDINGS_VALUES: unknown[] = [
  ABSENT, null, [], ROWS, [1, null, 'row', [], { o: 7 }, { o: { value: 7 } }],
  '', 'none', 0, 7, false, true, {}, { rows: [] },
];
const HOLDER_VALUES: unknown[] = [
  ABSENT, null, 3, 'str', true, [], {},
  ...BINDINGS_VALUES.filter((value) => value !== ABSENT).map((bindings) => ({ bindings })),
  { bindings: ROWS, head: { vars: ['p', 'o'] } },
];

function envelope(result: unknown, results: unknown, flat: unknown): string {
  const body: Record<string, unknown> = { type: 'bindings', phases: { execute: 3 } };
  if (result !== ABSENT) body.result = result;
  if (results !== ABSENT) body.results = results;
  if (flat !== ABSENT) body.bindings = flat;
  return JSON.stringify(body);
}

describe('queryNode reads a SELECT answer as it did before the shared module', () => {
  it('agrees with the frozen body on every envelope mix: accepted set, returned rows, error class and message', async () => {
    let cases = 0;
    let accepted = 0;
    let rejected = 0;
    const disagreements: string[] = [];
    for (const result of HOLDER_VALUES) {
      for (const results of HOLDER_VALUES) {
        for (const flat of BINDINGS_VALUES) {
          const body = envelope(result, results, flat);
          const actual = await realQueryNode(200, body);
          const expected = frozenOutcome(200, body);
          cases += 1;
          if ('returned' in expected) accepted += 1;
          else rejected += 1;
          try {
            expect(actual).toStrictEqual(expected);
          } catch {
            disagreements.push(`${body}\n  now: ${JSON.stringify(actual)}\n  was: ${JSON.stringify(expected)}`);
          }
        }
      }
    }
    expect(disagreements.slice(0, 5), `${disagreements.length} of ${cases} answers read differently`).toEqual([]);
    // Not vacuous: a corpus of this size has both outcomes many times over.
    expect(cases).toBeGreaterThan(4_000);
    expect(accepted).toBeGreaterThan(1_000);
    expect(rejected).toBeGreaterThan(1_000);
  });

  it.each([
    ['null', 'null'],
    ['a string', '"ok"'],
    ['a number', '42'],
    ['true', 'true'],
    ['an empty array', '[]'],
    ['an array of rows', JSON.stringify(ROWS)],
    ['an object with no bindings', '{}'],
    ['a body that is not JSON (read as null)', '<html>bad gateway</html>'],
    ['an empty body', ''],
    ['a long body (the message keeps 300 characters of it)', JSON.stringify({ note: 'x'.repeat(1_000), result: { bindings: 'no' } })],
    ['a body with a multi-byte character at the cut', JSON.stringify({ note: `${'x'.repeat(280)}${'é'.repeat(40)}` })],
  ])('reads %s as before', async (_what, body) => {
    expect(await realQueryNode(200, body)).toStrictEqual(frozenOutcome(200, body));
  });

  it.each([201, 301, 400, 401, 403, 404, 500, 502, 503])('fails on status %i with the same message as before', async (status) => {
    for (const body of ['{"error":"boom"}', 'null', '"text"', JSON.stringify({ result: { bindings: ROWS } }), '']) {
      expect(await realQueryNode(status, body)).toStrictEqual(frozenOutcome(status, body));
    }
  });

  it('returns the rows as the daemon sent them: extra fields, junk rows and structured cells untouched', async () => {
    const rows = [...ROWS, 'not-a-row', null, 7];
    const actual = await realQueryNode(200, JSON.stringify({ result: { bindings: rows } }));
    expect(actual).toStrictEqual({ returned: rows });
  });

  it('keeps the error a plain Error with the node number and the first 300 characters of the body', async () => {
    const actual = await realQueryNode(200, JSON.stringify({ note: 'x'.repeat(1_000) }));
    expect(actual).toMatchObject({ threw: { name: 'Error', isPlainError: true } });
    const message = (actual as { threw: { message: string } }).threw.message;
    expect(message.startsWith('unrecognised /api/query response shape on node7: {"note":"xxx')).toBe(true);
    expect(message).toHaveLength('unrecognised /api/query response shape on node7: '.length + 300);
  });
});
