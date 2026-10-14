import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SHAPES, assetBody, checkRows, isWithin, literalOf, sameValue, shape } from '../qa/content-shapes.mjs';

// Escapes are built from code points here as well: this file tests exact bytes.
const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const SOH = String.fromCharCode(1);
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ROOT = 'did:dkg:context-graph:0xabc/graph/_shared_memory';
const SUB = 'did:dkg:context-graph:0xabc/graph/shapes/_shared_memory';
const cli = fileURLToPath(new URL('../qa/content-shapes.mjs', import.meta.url));

// What a node answers for a shape, in the lexical forms of the given store.
function rowsOf(key, graph, forms = {}) {
  return shape(key).statements.map(s => ({
    g: `${graph}/0xabc/7`,
    p: s.predicate,
    o: forms[s.predicate] ?? s.term,
  }));
}
const typedAs = (value, datatype) => `"${value}"^^<${XSD}${datatype}>`;
const blazegraphForms = {
  'urn:issue3198:observedAt': typedAs('2026-10-12T13:08:51.000Z', 'dateTime'),
  'urn:issue3198:amount': typedAs('100.0', 'double'),
  'urn:issue3198:ratio': typedAs('5.0', 'float'),
};

test('the battery ends with a plain asset shared after the literals with control characters', () => {
  const keys = SHAPES.map(s => s.key);
  assert.deepEqual(keys, ['plain', 'typed', 'non-ascii', 'tabs', 'control', 'plain-after']);
  // The typed asset comes first, so that a refusal of it is not hidden behind an asset that blocks its author.
  assert.ok(keys.indexOf('typed') < keys.indexOf('tabs'));
  assert.equal(new Set(keys).size, keys.length);
});

test('a control character goes to the API as the escape of its N-Triples term, never raw', () => {
  const tabs = assetBody('tabs', 'cg', 'name', 'urn:s').quads[0].object;
  assert.equal(tabs, `"name${BS}tvalue${BS}tunit"`);
  assert.ok(!tabs.includes(TAB));
  const control = assetBody('control', 'cg', 'name', 'urn:s').quads[0].object;
  assert.equal(control, `"start${BS}u0001end"`);
  assert.ok(!control.includes(SOH));
  // The value the check expects back is the character itself.
  assert.equal(shape('tabs').statements[0].value, `name${TAB}value${TAB}unit`);
  assert.equal(shape('control').statements[0].value, `start${SOH}end`);
});

test('the request body is the one-call create: sealed, not shared, in the root or in a sub-graph', () => {
  const root = assetBody('typed', 'cg', 'asset', 'urn:s');
  assert.equal(root.finalize, true); assert.equal(root.alsoShareSwm, false);
  assert.ok(!('subGraphName' in root));
  assert.deepEqual(root.quads.map(q => q.object), [
    typedAs('2026-10-12T13:08:51Z', 'dateTime'), typedAs('100', 'double'), typedAs('5', 'float'), typedAs('PT1H', 'duration'),
  ]);
  assert.ok(root.quads.every(q => q.subject === 'urn:s' && q.graph === ''));
  assert.equal(assetBody('plain', 'cg', 'asset', 'urn:s', 'shapes').subGraphName, 'shapes');
  // Text outside ASCII includes a character beyond the BMP.
  const text = shape('non-ascii').statements[0].value;
  assert.ok([...text].some(c => c.codePointAt(0) > 0xffff) && [...text].some(c => c.codePointAt(0) > 0x7f && c.codePointAt(0) < 0x800));
});

test('a literal cell is decoded from the term or from a SPARQL results object', () => {
  assert.deepEqual(literalOf(`"a${BS}tb"`), { value: `a${TAB}b`, datatype: null });
  assert.deepEqual(literalOf(`"a${BS}u0001b"`), { value: `a${SOH}b`, datatype: null });
  assert.deepEqual(literalOf(`"${BS}U0001F600"`), { value: String.fromCodePoint(0x1f600), datatype: null });
  assert.deepEqual(literalOf(`"q${BS}"q${BS}${BS}"`), { value: `q"q${BS}`, datatype: null });
  assert.deepEqual(literalOf(typedAs('5.0', 'float')), { value: '5.0', datatype: `${XSD}float` });
  assert.deepEqual(literalOf(typedAs('x', 'string')), { value: 'x', datatype: null });
  assert.deepEqual(literalOf('"hi"@en'), { value: 'hi', datatype: null });
  assert.deepEqual(literalOf({ type: 'literal', value: `a${TAB}b` }), { value: `a${TAB}b`, datatype: null });
  assert.deepEqual(literalOf({ type: 'typed-literal', value: '100.0', datatype: `${XSD}double` }), { value: '100.0', datatype: `${XSD}double` });
  for (const notALiteral of ['urn:x', '<urn:x>', '"open', `"bad${BS}q"`, `"x"^^urn:y`, { type: 'uri', value: 'urn:x' }, null]) {
    assert.equal(literalOf(notALiteral), null);
  }
});

test('a store may answer a typed literal in its own lexical form, but not with another value or type', () => {
  const [at, amount, ratio, window] = shape('typed').statements;
  assert.ok(sameValue(at, { value: '2026-10-12T13:08:51.000Z', datatype: at.datatype }));
  assert.ok(sameValue(at, { value: '2026-10-12T15:08:51+02:00', datatype: at.datatype }));
  assert.ok(!sameValue(at, { value: '2026-10-12T13:08:52Z', datatype: at.datatype }));
  assert.ok(sameValue(amount, { value: '100.0', datatype: amount.datatype }));
  assert.ok(sameValue(amount, { value: '1.0E2', datatype: amount.datatype }));
  assert.ok(!sameValue(amount, { value: '100.5', datatype: amount.datatype }));
  assert.ok(!sameValue(amount, { value: '100', datatype: `${XSD}integer` }));
  assert.ok(!sameValue(amount, { value: '', datatype: amount.datatype }));
  assert.ok(sameValue(ratio, { value: '5.0', datatype: ratio.datatype }));
  assert.ok(sameValue(window, { value: 'PT60M', datatype: window.datatype }));
  assert.ok(sameValue(window, { value: 'P0DT1H0M0.000S', datatype: window.datatype }));
  assert.ok(!sameValue(window, { value: 'PT2H', datatype: window.datatype }));
  assert.ok(!sameValue(window, null));
  // Text is compared character for character.
  const [row] = shape('tabs').statements;
  assert.ok(sameValue(row, { value: `name${TAB}value${TAB}unit`, datatype: null }));
  assert.ok(!sameValue(row, { value: 'name value unit', datatype: null }));
});

test('an asset is present when every statement is in that shared memory with its value', () => {
  for (const s of SHAPES) assert.equal(checkRows(s.key, rowsOf(s.key, ROOT), ROOT).verdict, 'present', s.key);
  assert.equal(checkRows('typed', rowsOf('typed', ROOT, blazegraphForms), ROOT).verdict, 'present');
  assert.equal(checkRows('plain', rowsOf('plain', SUB), SUB).verdict, 'present');
  // SPARQL-results cells and bracketed IRIs are read the same way.
  const cells = rowsOf('tabs', ROOT).map(r => ({ g: { type: 'uri', value: r.g }, p: `<${r.p}>`, o: { type: 'literal', value: `name${TAB}value${TAB}unit` } }));
  assert.equal(checkRows('tabs', cells, ROOT).verdict, 'present');
});

test('absent, partial and different are told apart', () => {
  assert.deepEqual(checkRows('plain', [], ROOT), { verdict: 'absent', detail: '' });
  // In the sub-graph, in working memory or in the bookkeeping graph is not "in the root's shared memory".
  for (const elsewhere of [SUB, 'did:dkg:context-graph:0xabc/graph/_working_memory', `${ROOT}_meta`]) {
    assert.equal(checkRows('plain', rowsOf('plain', elsewhere), ROOT).verdict, 'absent', elsewhere);
  }
  assert.match(checkRows('plain', rowsOf('plain', SUB), ROOT).detail, /1 row\(s\) outside/);
  const partial = checkRows('typed', rowsOf('typed', ROOT).slice(0, 2), ROOT);
  assert.equal(partial.verdict, 'partial'); assert.match(partial.detail, /missing ratio, window/);
  const flattened = checkRows('tabs', rowsOf('tabs', ROOT, { 'urn:issue3198:row': '"name value unit"' }), ROOT);
  assert.equal(flattened.verdict, 'different'); assert.match(flattened.detail, /^row: wrote /);
  const dropped = checkRows('control', rowsOf('control', ROOT, { 'urn:issue3198:note': '"startend"' }), ROOT);
  assert.equal(dropped.verdict, 'different');
  // The diagnostic is printable: the control character is named, not printed.
  assert.ok(![...dropped.detail].some(c => c.codePointAt(0) < 0x20));
  assert.ok(isWithin(`${ROOT}/0xabc/1`, ROOT) && isWithin(ROOT, ROOT) && !isWithin(`${ROOT}_meta`, ROOT));
});

test('a written value beside another value is not the written value', () => {
  const beside = (key, predicate, term, graph = ROOT) => [...rowsOf(key, ROOT), { g: `${graph}/0xabc/8`, p: predicate, o: term }];
  // The reviewer's case: the text with its tabs AND a copy with the tabs flattened.
  const flattened = checkRows('tabs', beside('tabs', 'urn:issue3198:row', '"name value unit"'), ROOT);
  assert.equal(flattened.verdict, 'different');
  assert.match(flattened.detail, /^row: wrote "name\\tvalue\\tunit", read .*name value unit.* beside the written value$/);
  assert.equal(checkRows('control', beside('control', 'urn:issue3198:note', '"startend"'), ROOT).verdict, 'different');
  assert.equal(checkRows('typed', beside('typed', 'urn:issue3198:amount', typedAs('101', 'double')), ROOT).verdict, 'different');
  assert.equal(checkRows('typed', beside('typed', 'urn:issue3198:amount', typedAs('100', 'integer')), ROOT).verdict, 'different');
  assert.equal(checkRows('plain', beside('plain', 'urn:issue3198:label', '"first plain asset "'), ROOT).verdict, 'different');
  // Each wrong value is named once, however many graphs repeat it.
  const repeated = checkRows('plain', [...beside('plain', 'urn:issue3198:label', '"x"'), { g: `${ROOT}/0xabc/9`, p: 'urn:issue3198:label', o: '"x"' }], ROOT);
  assert.equal(repeated.detail.match(/"\\"x\\""/g).length, 1, repeated.detail);

  // One value in two lexical forms is one value: a store that rewrites the literal in one of two graphs.
  assert.equal(checkRows('typed', beside('typed', 'urn:issue3198:amount', typedAs('100.0', 'double')), ROOT).verdict, 'present');
  assert.equal(checkRows('typed', beside('typed', 'urn:issue3198:observedAt', typedAs('2026-10-12T13:08:51.000Z', 'dateTime')), ROOT).verdict, 'present');
  assert.equal(checkRows('tabs', [...rowsOf('tabs', ROOT), ...rowsOf('tabs', ROOT)], ROOT).verdict, 'present');
  // A value outside the shared memory that was asked for is not this check's business.
  assert.equal(checkRows('tabs', beside('tabs', 'urn:issue3198:row', '"name value unit"', SUB), ROOT).verdict, 'present');
  assert.equal(checkRows('tabs', beside('tabs', 'urn:issue3198:row', '"name value unit"', 'did:dkg:context-graph:0xabc/graph/_working_memory'), ROOT).verdict, 'present');
  // Something missing is still reported as missing first: the node may not be done.
  const partial = checkRows('typed', beside('typed', 'urn:issue3198:amount', typedAs('7', 'double')).filter(row => row.p !== 'urn:issue3198:window'), ROOT);
  assert.equal(partial.verdict, 'partial');
});

test('the command line answers with the exit codes the shell script reads', () => {
  const run = (args, input = '') => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
  assert.deepEqual(run(['list']).stdout.trim().split('\n'), SHAPES.map(s => s.key));
  const body = JSON.parse(run(['body', 'tabs', 'cg', 'asset', 'urn:s', 'shapes']).stdout);
  assert.deepEqual(body, assetBody('tabs', 'cg', 'asset', 'urn:s', 'shapes'));
  const present = run(['check', 'typed', ROOT], JSON.stringify(rowsOf('typed', ROOT, blazegraphForms)));
  assert.equal(present.status, 0); assert.equal(present.stdout.trim(), 'present');
  assert.equal(run(['check', 'typed', ROOT], '[]').status, 1);
  const different = run(['check', 'tabs', ROOT], JSON.stringify(rowsOf('tabs', ROOT, { 'urn:issue3198:row': '"x"' })));
  assert.equal(different.status, 4); assert.match(different.stdout, /^different row: /);
  assert.equal(run(['check', 'typed', ROOT], 'not json').status, 2);
  assert.equal(run(['check', 'no-such-shape', ROOT], '[]').status, 2);
  assert.equal(run(['body', 'plain']).status, 2);
});
