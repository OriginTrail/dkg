import assert from 'node:assert/strict';
import test from 'node:test';
import { caseVerdicts, inScope, judgeHeld, linkProblem, literalText, sharedMemoryScope } from '../qa/member-sharing.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const LABEL = 'urn:issue3251:label';
const written = { predicate: LABEL, value: 'owner live root (7)' };

test('a literal cell is read in each form the query API answers, and nothing else passes for a text', () => {
  assert.equal(literalText('"owner live root (7)"'), 'owner live root (7)');
  assert.equal(literalText(`"owner live root (7)"^^<${XSD}string>`), 'owner live root (7)');
  assert.equal(literalText('"owner live root (7)"@en'), 'owner live root (7)');
  assert.equal(literalText('"owner live root (7)"@en-GB'), 'owner live root (7)');
  assert.equal(literalText({ type: 'literal', value: 'owner live root (7)' }), 'owner live root (7)');
  assert.equal(literalText({ type: 'literal', value: 'x', datatype: `${XSD}string` }), 'x');
  assert.equal(literalText('""'), '');
  for (const cell of [
    'urn:issue3251:label', '<urn:issue3251:label>', '"unterminated', '"', `"7"^^<${XSD}integer>`, '"x"junk',
    { type: 'uri', value: 'urn:x' }, { type: 'bnode', value: 'b0' }, { type: 'literal', value: '7', datatype: `${XSD}integer` },
    { type: 'literal' }, null, undefined, 7,
  ]) assert.equal(literalText(cell), null, JSON.stringify(cell));
});

test('a write is held when its predicate is there and every value held for it is the written one', () => {
  assert.deepEqual(judgeHeld([], written), { held: false });
  assert.deepEqual(judgeHeld([{ p: 'urn:other', o: '"owner live root (7)"' }], written), { held: false });
  assert.deepEqual(judgeHeld([{ p: LABEL, o: '"owner live root (7)"' }], written), { held: true });
  assert.deepEqual(judgeHeld([{ p: `<${LABEL}>`, o: { type: 'literal', value: 'owner live root (7)' } }], written), { held: true });
  // The same value held twice (two graphs below the same shared memory) is still the one value.
  assert.deepEqual(judgeHeld([{ p: LABEL, o: '"owner live root (7)"' }, { p: LABEL, o: `"owner live root (7)"^^<${XSD}string>` }], written), { held: true });
});

test('a written value beside another value is not the write', () => {
  const both = judgeHeld([{ p: LABEL, o: '"owner live root (7)"' }, { p: LABEL, o: '"owner live root (8)"' }], written);
  assert.equal(both.held, false);
  assert.equal(both.different, '"owner live root (8)"');
  const typed = judgeHeld([{ p: LABEL, o: `"7"^^<${XSD}integer>` }], written);
  assert.deepEqual(typed, { held: false, different: 'a value that is not a text' });
});

test('the cross-partition read counts only the shared memory that was asked for', () => {
  const cg = '0xabc/issue-3251-public-20261015T080000Z-1';
  const root = sharedMemoryScope(cg, null);
  const sub = sharedMemoryScope(cg, 's');
  assert.equal(root, `did:dkg:context-graph:${cg}/_shared_memory`);
  assert.equal(sub, `did:dkg:context-graph:${cg}/s/_shared_memory`);
  assert.ok(inScope(root, root));
  assert.ok(inScope(`<${root}>`, root));
  assert.ok(inScope({ type: 'uri', value: `${root}/0xauthor/1` }, root), 'a graph below the shared memory, one per asset');
  assert.ok(inScope(`${sub}/0xauthor/1`, sub));
  assert.ok(!inScope(sub, root), 'a sub-graph is not the root');
  assert.ok(!inScope(`${sub}/0xauthor/1`, root));
  assert.ok(!inScope(root, sub));
  assert.ok(!inScope(`did:dkg:context-graph:${cg}/_shared_memory_meta`, root), 'not the bookkeeping graph beside it');
  assert.ok(!inScope(`did:dkg:context-graph:${cg}`, root), 'not the data graph');
  assert.ok(!inScope(`did:dkg:context-graph:${cg}-other/_shared_memory`, root), 'not another graph with a longer id');
});

test('the topology holds only on relayed links between a member and the owner and on no link between the members', () => {
  assert.equal(linkProblem({ readable: true, total: 1, relayed: 1 }, 'relayed', 'node8', 'node7'), null);
  assert.equal(linkProblem({ readable: true, total: 2, relayed: 2 }, 'relayed', 'node8', 'node7'), null);
  assert.equal(linkProblem({ readable: true, total: 0, relayed: 0 }, 'relayed', 'node8', 'node7'), 'node8 holds no connection to node7');
  assert.equal(linkProblem({ readable: true, total: 2, relayed: 1 }, 'relayed', 'node8', 'node7'), 'node8 holds 1 direct connection(s) to node7');
  assert.equal(linkProblem({ readable: true, total: 0, relayed: 0 }, 'none', 'node8', 'node9'), null);
  assert.equal(linkProblem({ readable: true, total: 1, relayed: 1 }, 'none', 'node8', 'node9'), 'node8 holds 1 connection(s) to node9');
  // A list that could not be read says nothing, whichever answer was expected.
  for (const expect of ['relayed', 'none']) {
    assert.equal(linkProblem({ readable: false }, expect, 'node8', 'node9'), 'the connections of node8 could not be read');
    assert.equal(linkProblem(undefined, expect, 'node8', 'node9'), 'the connections of node8 could not be read');
  }
});

test('a case passes only when something held and nothing failed; a case that never ran does not pass', () => {
  const cases = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };
  const { rows, failed } = caseVerdicts(cases, {
    1: { pass: 4, fail: [] },
    2: { pass: 3, fail: ['member1 -> member2 missing'] },
    3: { pass: 0, fail: [] },
  });
  assert.deepEqual(rows.map(row => [row.id, row.verdict, row.held, row.failed]),
    [['1', 'PASS', 4, 0], ['2', 'FAIL', 3, 1], ['3', 'NOT RUN', 0, 0], ['4', 'NOT RUN', 0, 0]]);
  assert.deepEqual(failed, ['2', '3', '4']);
  assert.deepEqual(caseVerdicts({ 1: 'one' }, { 1: { pass: 1, fail: [] } }).failed, []);
});
