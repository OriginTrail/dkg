// Content shapes for devnet-test-issue-3198-content-shapes.sh.
//
// One knowledge asset per shape. A shape is a kind of literal that a node may
// write, send or read back in another form than the one it was given:
//   - a control character, which the N-Triples term the API takes carries as an
//     escape and the canonical form of the term carries raw;
//   - a typed literal whose lexical form a store normalises when it returns it
//     (Blazegraph answers "...:51.000Z" for "...:51Z", "100.0" for "100");
//   - text outside ASCII.
// The assets are made here and nowhere else, so that the script that shares
// them and the check that reads them back agree on every character.
//
// This file is ASCII only, on purpose. Every backslash of an escape is built
// from BS and every character outside ASCII from its code point, so no editor
// or tool can silently turn an escape in this file into the character it names.
//
// CLI (used by the shell script):
//   content-shapes.mjs list                              shape keys, in battery order
//   content-shapes.mjs describe <key>                    one line of what the shape is
//   content-shapes.mjs body <key> <contextGraphId> <name> <subject> [subGraphName]
//                                                        body for POST /api/knowledge-assets
//   content-shapes.mjs check <key> <sharedMemoryGraph>   stdin: the binding rows of
//       SELECT ?g ?p ?o WHERE { GRAPH ?g { <subject> ?p ?o } }; prints one verdict line.
//       <sharedMemoryGraph> is the shared-memory graph of the context graph or of the
//       sub-graph the asset was shared into; its assets live in graphs below it.
//       Exit 0 present, 1 absent or partial (ask again), 4 present with another value.

import { pathToFileURL } from 'node:url';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const SOH = String.fromCharCode(1);
const P = 'urn:issue3198:';

// name<TAB>value<TAB>unit, as a spreadsheet row pasted into a note.
const tabbedTerm = 'name' + BS + 't' + 'value' + BS + 't' + 'unit';
const tabbedValue = 'name' + TAB + 'value' + TAB + 'unit';
// U+0001 written as the six-character N-Triples escape.
const controlTerm = 'start' + BS + 'u0001' + 'end';
const controlValue = 'start' + SOH + 'end';
// Latin with diacritics, Cyrillic, CJK and one character outside the BMP.
const nonAscii = String.fromCodePoint(
  0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x20,
  0x416, 0x443, 0x43a, 0x20, 0x6771, 0x4eac, 0x20, 0x1f600,
);

const plain = (predicate, value) => ({ predicate: P + predicate, term: `"${value}"`, value, datatype: null });
const typed = (predicate, value, datatype) => ({
  predicate: P + predicate, term: `"${value}"^^<${XSD}${datatype}>`, value, datatype: XSD + datatype,
});

export const SHAPES = [
  { key: 'plain', what: 'plain text', statements: [plain('label', 'first plain asset')] },
  {
    key: 'typed',
    what: 'whole-second xsd:dateTime, integral xsd:double and xsd:float, xsd:duration',
    statements: [
      typed('observedAt', '2026-10-12T13:08:51Z', 'dateTime'),
      typed('amount', '100', 'double'),
      typed('ratio', '5', 'float'),
      typed('window', 'PT1H', 'duration'),
    ],
  },
  { key: 'non-ascii', what: 'text outside ASCII', statements: [plain('label', nonAscii)] },
  {
    key: 'tabs',
    what: 'a literal with tabs',
    statements: [{ predicate: P + 'row', term: `"${tabbedTerm}"`, value: tabbedValue, datatype: null }],
  },
  {
    key: 'control',
    what: 'a literal with the control character U+0001',
    statements: [{ predicate: P + 'note', term: `"${controlTerm}"`, value: controlValue, datatype: null }],
  },
  { key: 'plain-after', what: 'plain text, shared after the literals with control characters', statements: [plain('label', 'last plain asset')] },
];

export function shape(key) {
  const found = SHAPES.find(s => s.key === key);
  if (!found) throw new Error(`unknown shape "${key}"`);
  return found;
}

export function assetBody(key, contextGraphId, name, subject, subGraphName) {
  return {
    contextGraphId,
    name,
    ...(subGraphName ? { subGraphName } : {}),
    quads: shape(key).statements.map(s => ({ subject, predicate: s.predicate, object: s.term, graph: '' })),
    finalize: true,
    alsoShareSwm: false,
  };
}

// The value and datatype of a literal cell of the query API. A cell is the
// N-Triples term as a string, or a SPARQL-results object.
export function literalOf(cell) {
  if (cell !== null && typeof cell === 'object') {
    if (typeof cell.value !== 'string' || cell.type === 'uri' || cell.type === 'bnode') return null;
    return { value: cell.value, datatype: typeof cell.datatype === 'string' ? cell.datatype : null };
  }
  if (typeof cell !== 'string' || cell[0] !== '"') return null;
  let value = '';
  let i = 1;
  for (; i < cell.length && cell[i] !== '"'; i++) {
    if (cell[i] !== BS) { value += cell[i]; continue; }
    const escape = cell[++i];
    const hex = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (hex) {
      const digits = cell.slice(i + 1, i + 1 + hex);
      if (!new RegExp(`^[0-9A-Fa-f]{${hex}}$`).test(digits)) return null;
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      i += hex;
    } else {
      const simple = { t: TAB, n: String.fromCharCode(10), r: String.fromCharCode(13), b: String.fromCharCode(8), f: String.fromCharCode(12), '"': '"', "'": "'" }[escape];
      if (simple !== undefined) value += simple;
      else if (escape === BS) value += BS;
      else return null;
    }
  }
  if (cell[i] !== '"') return null;
  const rest = cell.slice(i + 1);
  if (rest === '' || rest[0] === '@') return { value, datatype: null };
  const datatype = /^\^\^<([^<>]+)>$/.exec(rest);
  if (!datatype) return null;
  return { value, datatype: datatype[1] === XSD + 'string' ? null : datatype[1] };
}

function durationSeconds(lexical) {
  const m = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(lexical);
  if (!m) return null;
  const [, sign, y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = m;
  const months = Number(y) * 12 + Number(mo);
  const seconds = ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s);
  return `${sign ?? ''}${months}m${seconds}s`;
}

// Same value, whatever lexical form the store chose to answer in.
export function sameValue(expected, actual) {
  if (!actual || expected.datatype !== actual.datatype) return false;
  if (expected.value === actual.value) return true;
  const local = (expected.datatype ?? '').slice(XSD.length);
  if (local === 'dateTime') {
    const a = Date.parse(expected.value);
    return Number.isFinite(a) && a === Date.parse(actual.value);
  }
  if (local === 'double' || local === 'float') {
    const a = Number(expected.value);
    return Number.isFinite(a) && actual.value.trim() !== '' && a === Number(actual.value);
  }
  if (local === 'duration') {
    const a = durationSeconds(expected.value);
    return a !== null && a === durationSeconds(actual.value);
  }
  return false;
}

const cellText = cell => (cell !== null && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));
const bare = iri => iri.replace(/^<|>$/g, '');
// The shared-memory graph itself or one of the per-asset graphs below it; not
// the bookkeeping graph beside it, and not the shared memory of a sub-graph
// when the root was asked for.
export const isWithin = (graph, sharedMemoryGraph) => graph === sharedMemoryGraph || graph.startsWith(`${sharedMemoryGraph}/`);
const printable = value => JSON.stringify(value).replace(/[^\x20-\x7e]/g, c => `${BS}u{${c.codePointAt(0).toString(16)}}`);

// rows: [{ g, p, o }] for one subject. Every statement of the shape must be in
// that shared memory with the value it was written with, and with no other
// value: a node that answers the written text AND a corrupted copy of it holds
// corrupted content. The same value in two lexical forms (two graphs of a
// store that rewrites one of them) is one value.
export function checkRows(key, rows, sharedMemoryGraph) {
  const statements = shape(key).statements;
  const shared = rows.filter(row => isWithin(bare(cellText(row.g)), sharedMemoryGraph));
  const missing = [];
  const different = [];
  for (const statement of statements) {
    const found = shared.filter(row => bare(cellText(row.p)) === statement.predicate);
    if (found.length === 0) { missing.push(statement.predicate.slice(P.length)); continue; }
    const others = found.filter(row => !sameValue(statement, literalOf(row.o)));
    if (others.length) {
      const read = [...new Set(others.map(row => printable(cellText(row.o))))].join(' | ');
      different.push(`${statement.predicate.slice(P.length)}: wrote ${printable(statement.value)}, read ${read}${others.length < found.length ? ' beside the written value' : ''}`);
    }
  }
  if (missing.length === statements.length) {
    const elsewhere = rows.length - shared.length;
    return { verdict: 'absent', detail: elsewhere ? `${elsewhere} row(s) outside that shared memory` : '' };
  }
  if (missing.length) return { verdict: 'partial', detail: `missing ${missing.join(', ')}` };
  if (different.length) return { verdict: 'different', detail: different.join('; ') };
  return { verdict: 'present', detail: '' };
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'list') return SHAPES.forEach(s => console.log(s.key));
  if (command === 'describe') return console.log(shape(args[0]).what);
  if (command === 'body') {
    const [key, contextGraphId, name, subject, subGraphName] = args;
    if (!key || !contextGraphId || !name || !subject) throw new Error('usage: body <key> <contextGraphId> <name> <subject> [subGraphName]');
    return console.log(JSON.stringify(assetBody(key, contextGraphId, name, subject, subGraphName)));
  }
  if (command === 'check') {
    if (!args[0] || !args[1]) throw new Error('usage: check <key> <sharedMemoryGraph>');
    shape(args[0]);
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      let rows;
      try { rows = JSON.parse(input); } catch { rows = null; }
      if (!Array.isArray(rows)) { console.log('unreadable'); process.exitCode = 2; return; }
      const result = checkRows(args[0], rows, args[1]);
      console.log(result.detail ? `${result.verdict} ${result.detail}` : result.verdict);
      process.exitCode = result.verdict === 'present' ? 0 : result.verdict === 'different' ? 4 : 1;
    });
    return undefined;
  }
  throw new Error('usage: content-shapes.mjs list | describe <key> | body ... | check <key> <sharedMemoryGraph>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
