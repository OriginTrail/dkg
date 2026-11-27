const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 }); };
const closed = (v, keys) => { if (!record(v) || Object.keys(v).some(k => !keys.includes(k))) fail('Unexpected workflow fields.'); };
const identifier = v => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/i.test(v)) fail('Invalid block identity.'); return v; };

/** Pure host topology rules; revision-specific node limits, descriptors and source bytes stay with the compiler. */
export function normalizeStudioTopology({ nodes, edges: rawEdges, entryId: rawEntryId }, component) {
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail('Block identities must be unique.');
  if (nodes.filter(n => n.componentId === 'loop-items').length > 1) fail('This PoC supports one Loop Over Items block per workflow.');
  const byId = new Map(nodes.map(n => [n.id, n]));
  const entryId = identifier(rawEntryId);
  if (!byId.has(entryId)) fail('Choose the first block.');
  const edges = rawEdges.map(e => {
    closed(e, ['from', 'output', 'to', 'input']);
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a === b || !Number.isInteger(e.output) || e.output < 0 || e.output >= component(a.componentId).outputs.length
      || !Number.isInteger(e.input) || e.input < 0 || e.input >= (component(b.componentId).inputs ?? 1)) fail('Connect valid input and output ports.');
    if (['schedule', 'webhook'].includes(b.componentId)) fail('An event trigger must be the first block.');
    if (component(b.componentId).input === 'file' && component(a.componentId).outputs[e.output] !== 'file') fail('Connect a file output to this file input.');
    return { from: a.id, output: e.output, to: b.id, input: e.input };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const seen = new Set();
  for (const e of edges) { const key = `${e.to}:${e.input}`; if (seen.has(key) && byId.get(e.to).componentId !== 'loop-items') fail('Each input port accepts one connection. Use Merge to combine branches.'); seen.add(key); }
  if (new Set(edges.map(e => JSON.stringify(e))).size !== edges.length) fail('Duplicate connection.');
  // A loop has one initial input and exactly one return from its body. All other cycles are rejected.
  const returns = new Set();
  const reachable = (from, target, ignore = new Set(), visited = new Set()) => {
    if (from === target) return true;
    if (visited.has(from)) return false; visited.add(from);
    return edges.some(e => e.from === from && !ignore.has(e) && reachable(e.to, target, ignore, visited));
  };
  for (const n of nodes.filter(n => n.componentId === 'loop-items')) {
    const starts = edges.filter(e => e.from === n.id && e.output === 1);
    if (starts.length !== 1) fail('Connect the loop output to one loop body.');
    const back = edges.filter(e => e.to === n.id && reachable(starts[0].to, e.from, new Set(edges.filter(v => v.to === n.id))));
    if (back.length !== 1) fail('Connect the last loop-body block back to Loop Over Items.');
    returns.add(back[0]);
    if (n.id !== entryId && edges.filter(e => e.to === n.id && !back.includes(e)).length !== 1) fail('A loop needs one initial input.');
  }
  const visiting = new Set(), visited = new Set();
  const walk = id => { if (visiting.has(id)) fail('Only a Loop Over Items return may form a cycle.'); if (visited.has(id)) return;
    visiting.add(id); for (const e of edges.filter(e => e.from === id && !returns.has(e))) walk(e.to); visiting.delete(id); visited.add(id); };
  walk(entryId);
  if (visited.size !== nodes.length) fail('Connect every block to the first block.');
  if (edges.some(e => e.to === entryId && !returns.has(e))) fail('The first block cannot have an incoming connection.');
  for (const n of nodes) {
    if (n.id !== entryId && component(n.componentId).inputs === 2 && [0, 1].some(i => !edges.some(e => e.to === n.id && e.input === i))) fail('Connect both inputs of the join block.');
    if (n.id !== entryId && ['schedule', 'webhook'].includes(n.componentId)) fail('Place event triggers first.');
  }
  if (component(byId.get(entryId).componentId).inputs === 2) fail('A join needs two upstream blocks.');
  return { entryId, edges };
}
