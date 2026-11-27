import assert from 'node:assert/strict';
import { componentPiece, editNode, nativeNode, wire } from '../component-workflows.mjs';

const a1 = { leftKey: 'match', leftId: 'a1', shared: 'left' };
const a2 = { leftKey: 'left-only', leftId: 'a2' };
const b1 = { rightKey: 'match', rightId: 'b1', shared: 'right' };
const b2 = { rightKey: 'right-only', rightId: 'b2' };
const a3 = { leftKey: 'match', leftId: 'a3', shared: 'left-second' };
const b3 = { rightKey: 'match', rightId: 'b3', shared: 'right-second' };
const pair = (a, b) => ({ ...b, ...a });
export const joinCases = [
  { id: 'outer', mode: 'keepEverything', left: [a1, a2], right: [b1, b2], expected: [pair(a1, b1), a2, b2] },
  { id: 'inner', mode: 'keepMatches', left: [a1, a2], right: [b1, b2], expected: [pair(a1, b1)] },
  { id: 'nonmatches', mode: 'keepNonMatches', left: [a1, a2], right: [b1, b2], expected: [{ ...a2, _source: 'input1' }, { ...b2, _source: 'input2' }] },
  { id: 'duplicates-outer', mode: 'keepEverything', left: [a1, a2, a3], right: [b1, b2, b3], expected: [pair(a1, b1), pair(a1, b3), pair(a3, b1), pair(a3, b3), a2, b2] },
  { id: 'duplicates-inner', mode: 'keepMatches', left: [a1, a2, a3], right: [b1, b2, b3], expected: [pair(a1, b1), pair(a1, b3), pair(a3, b1), pair(a3, b3)] },
  { id: 'duplicates-nonmatches', mode: 'keepNonMatches', left: [a1, a2, a3], right: [b1, b2, b3], expected: [{ ...a2, _source: 'input1' }, { ...b2, _source: 'input2' }] },
  { id: 'append', component: 'merge', left: [a1, a2], right: [b1, b2], expected: [a1, a2, b1, b2] },
  { id: 'append-duplicates', component: 'merge', left: [a1, a2, a3], right: [b1, b2, b3], expected: [a1, a2, a3, b1, b2, b3] },
];

/** The production component generator supplies every Merge node and parameter. */
export function fieldJoinWorkflow() {
  const start = { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {}, position: [0, 0] };
  const nodes = [start], connections = {};
  for (const c of joinCases) {
    const parameters = { fieldA: 'leftKey', fieldB: 'rightKey', joinMode: c.mode };
    const piece = componentPiece(c.component ?? 'merge-fields', c.id, key => JSON.stringify(parameters[key]));
    nodes.push(...piece.nodes); Object.assign(connections, piece.connections);
    for (const [input, records] of [c.left, c.right].entries()) {
      const seed = editNode(c.id + ' seed ' + input, JSON.stringify({ records }));
      const split = nativeNode(c.id + ' split ' + input, 'splitOut', { fieldToSplitOut: 'records', include: 'noOtherFields', options: { destinationFieldName: 'record' } });
      const unwrap = editNode(c.id + ' input ' + input, '$json.record');
      nodes.push(seed, split, unwrap);
      wire(connections, start.name, seed.name); wire(connections, seed.name, split.name);
      wire(connections, split.name, unwrap.name); wire(connections, unwrap.name, piece.entry, 0, input);
    }
  }
  nodes.forEach((n, i) => { n.position = [i * 100, 0]; });
  return { id: 'fieldJoinProof01', name: 'Generated field join native regression', active: false, nodes, connections,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' } };
}

const canonical = row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
export function verifyFieldJoinExecution(execution) {
  assert.equal(execution.data?.resultData?.error, undefined, 'The native workflow must complete successfully.');
  const proof = [];
  for (const c of joinCases) {
    const runs = execution.data?.resultData?.runData?.[c.id];
    assert.ok(Array.isArray(runs) && runs.length === 1, c.id + ' must execute exactly once');
    const rows = runs.flatMap(run => run.data.main[0].map(item => item.json));
    // A join is a multiset: compare every field and retain duplicate multiplicity.
    assert.deepEqual(rows.map(canonical).sort(), c.expected.map(canonical).sort(), c.id);
    // Append additionally promises input order and must keep both conflicting fields.
    if (c.component === 'merge') assert.deepEqual(rows, c.expected, c.id + ' order');
    proof.push({ case: c.id, outputRecords: rows.length, verified: true });
  }
  return proof;
}
