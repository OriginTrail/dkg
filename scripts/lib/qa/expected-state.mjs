// Bounded wait for a list of expected reads on devnet nodes.
//
// One expectation names a node, a context graph, a view and a subject, and the
// exact set of schema:name values that subject must have there. "Exact" is the
// point: an asset that was updated must read as its last version only, so a
// node that kept the old value next to the new one does not meet it.
//
// An expectation may name `tolerated` values: values that may be read beside
// the expected ones without failing it. Nothing else is tolerated, and a
// tolerated value that was read is carried in the result and printed, so a
// caller that accepts a known leftover still shows it on every run.
//
// Every answer goes through parseObservation, the same parser the other devnet
// suites use, so an error body is never read as "no rows". Reads are injected:
// the wait itself has no network, clock or file access of its own.
import { parseObservation } from './query-observation.mjs';

const NAME = 'http://schema.org/name';
const VIEWS = new Set(['verifiable-memory', 'shared-working-memory']);
const safeIri = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  && ![...value].some(c => c.codePointAt(0) <= 0x20 || c.codePointAt(0) === 0x7F) && !/[<>"{}|\\^`]/.test(value);

/** Reject a list this module cannot check, with the reason. Returns the list. */
export function validateExpectations(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('expectations must be a non-empty array');
  list.forEach((e, i) => {
    const where = `expectation ${i + 1}`;
    if (e === null || typeof e !== 'object') throw new Error(`${where}: not an object`);
    if (typeof e.label !== 'string' || !e.label) throw new Error(`${where}: label is required`);
    if (!Number.isInteger(e.node) || e.node < 1) throw new Error(`${where}: node must be a positive integer`);
    if (typeof e.contextGraphId !== 'string' || !e.contextGraphId) throw new Error(`${where}: contextGraphId is required`);
    if (!VIEWS.has(e.view)) throw new Error(`${where}: view must be one of ${[...VIEWS].join(', ')}`);
    if (!safeIri(e.subject)) throw new Error(`${where}: subject is not a safe IRI`);
    if (!Array.isArray(e.values) || e.values.some(v => typeof v !== 'string')) throw new Error(`${where}: values must be an array of strings`);
    if (e.tolerated !== undefined && (!Array.isArray(e.tolerated) || e.tolerated.some(v => typeof v !== 'string'))) {
      throw new Error(`${where}: tolerated must be an array of strings`);
    }
  });
  return list;
}

/** The request body for one expectation. */
export function queryFor(expectation) {
  return {
    sparql: `SELECT ?name WHERE { <${expectation.subject}> <${NAME}> ?name }`,
    contextGraphId: expectation.contextGraphId,
    view: expectation.view,
  };
}

/** Lexical form of a bindings cell. The API answers canonical N-Triples terms as strings. */
export function literalText(cell) {
  const term = cell !== null && typeof cell === 'object' ? cell.value : cell;
  const quoted = /^"([\s\S]*)"(?:\^\^<[^<>]+>|@[A-Za-z]+(?:-[A-Za-z0-9]+)*)?$/.exec(String(term));
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : String(term);
}

/**
 * Classify one answer ({ transportExit, httpStatus, body }) against its expectation:
 *   met        the subject has exactly the expected values (`tolerated` lists the
 *              tolerated values that were read beside them, when there are any)
 *   different  a valid read with other values (evidence of a wrong or late state)
 *   settling   the member's read authority is not available yet (ask again)
 *   invalid    no evidence: transport failure, HTTP error, error envelope, malformed answer
 */
export function classifyRead(expectation, answer) {
  const observation = parseObservation({ ...answer, format: 'api', mode: 'bindings', binding: 'name', settling: true });
  if (observation.outcome === 'SETTLING') return { state: 'settling', reason: observation.reason };
  if (observation.outcome !== 'PASS') return { state: 'invalid', reason: observation.reason };
  const values = [...new Set(observation.rows.map(row => literalText(row.name)))].sort();
  const expected = new Set(expectation.values);
  const mayAlsoRead = new Set(expectation.tolerated ?? []);
  const beside = values.filter(value => !expected.has(value));
  const met = [...expected].every(value => values.includes(value)) && beside.every(value => mayAlsoRead.has(value));
  if (!met) return { state: 'different', values };
  return beside.length === 0 ? { state: 'met', values } : { state: 'met', values, tolerated: beside };
}

/**
 * Poll until every expectation is met or the deadline passes. An expectation
 * that was met is not read again. Returns one result per expectation, in order:
 *   { expectation, met, afterMs, polls, last: { state, values?, reason? } }
 */
export async function awaitExpectations({ expectations, read, now, sleep, timeoutMs, intervalMs, onMet }) {
  const started = now();
  const results = expectations.map(expectation => ({ expectation, met: false, afterMs: null, polls: 0, last: null }));
  for (;;) {
    for (const result of results) {
      if (result.met) continue;
      let answer;
      try { answer = await read(result.expectation); } catch { answer = { transportExit: 1, httpStatus: null, body: '' }; }
      result.polls += 1;
      result.last = classifyRead(result.expectation, answer);
      if (result.last.state === 'met') {
        result.met = true;
        result.afterMs = now() - started;
        onMet?.(result);
      }
    }
    if (results.every(result => result.met) || now() - started >= timeoutMs) return results;
    await sleep(intervalMs);
  }
}

/** 0: all met. 1: a valid read showed another state. 2: an unmet expectation was never validly read. */
export function expectationsExit(results) {
  if (results.every(result => result.met)) return 0;
  return results.some(result => !result.met && result.last?.state === 'different') ? 1 : 2;
}

/** One line per result, for a suite log. No token, no response body. */
export function describeResult(result) {
  const { expectation, met, afterMs, polls, last } = result;
  if (met) {
    const beside = last?.tolerated?.length ? `; also read ${JSON.stringify(last.tolerated)}, tolerated` : '';
    return `ok     ${expectation.label} (after ${Math.round(afterMs / 1000)}s, ${polls} read${polls === 1 ? '' : 's'})${beside}`;
  }
  if (last?.state === 'different') {
    const allowed = expectation.tolerated?.length ? ` (tolerated beside them: ${JSON.stringify([...new Set(expectation.tolerated)].sort())})` : '';
    return `WRONG  ${expectation.label}: read ${JSON.stringify(last.values)}, expected ${JSON.stringify([...new Set(expectation.values)].sort())}${allowed}`;
  }
  return `UNREAD ${expectation.label}: no valid read in ${polls} attempt${polls === 1 ? '' : 's'} (${last?.reason ?? 'not read'})`;
}
