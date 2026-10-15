// The judgements of devnet-test-issue-3251-member-sharing.mjs, kept apart from
// its devnet I/O so that each one is tested on its own.

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

const cellText = cell => (cell !== null && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));
const bare = iri => iri.replace(/^<|>$/g, '');

/**
 * The text of a literal cell of the query API: an N-Triples term (`"text"`,
 * `"text"@en`, `"text"^^<xsd:string>`) or a SPARQL-results object. The suite
 * writes plain ASCII without quotes or backslashes, so no escape is decoded;
 * anything else (an IRI, a blank node, a typed literal of another type, a cell
 * that is not a term) is not a text and answers null.
 */
export function literalText(cell) {
  if (cell !== null && typeof cell === 'object') {
    if (cell.type === 'uri' || cell.type === 'bnode' || typeof cell.value !== 'string') return null;
    return typeof cell.datatype === 'string' && cell.datatype !== XSD_STRING ? null : cell.value;
  }
  if (typeof cell !== 'string' || !cell.startsWith('"')) return null;
  const end = cell.lastIndexOf('"');
  if (end < 1) return null;
  const rest = cell.slice(end + 1);
  return rest === '' || /^@[A-Za-z]+(-[A-Za-z0-9]+)*$/.test(rest) || rest === `^^<${XSD_STRING}>` ? cell.slice(1, end) : null;
}

/**
 * Whether rows of one subject hold the written value: the predicate is there,
 * and every value held for it is the written one. A node that answers the
 * written value AND another one holds corrupted content, not the write.
 */
export function judgeHeld(rows, { predicate, value }) {
  const found = rows.filter(row => bare(cellText(row.p)) === predicate);
  if (found.length === 0) return { held: false };
  const other = found.map(row => literalText(row.o)).filter(text => text !== value);
  if (other.length === 0) return { held: true };
  return { held: false, different: [...new Set(other.map(text => (text === null ? 'a value that is not a text' : JSON.stringify(text))))].join(' | ') };
}

/** The shared memory of a context graph's root, or of one of its sub-graphs. */
export const sharedMemoryScope = (contextGraphId, subGraphName) =>
  `did:dkg:context-graph:${contextGraphId}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory`;

/**
 * A graph of a cross-partition read is in a scope when it is the scope itself
 * or a graph below it (one per asset), not a sub-graph's shared memory when the
 * root was asked for, and not the bookkeeping graph beside it.
 */
export function inScope(graphCell, scope) {
  const graph = bare(cellText(graphCell));
  return graph === scope || graph.startsWith(`${scope}/`);
}

/**
 * What the connections of one node to one peer say about the topology.
 * `link` is { readable, total, relayed } (from /api/connections); `expect` is
 * 'relayed' (at least one connection, every one through a relay) or 'none'.
 * Returns the problem as a sentence, or null. An unreadable list is a
 * problem: it says nothing about the link.
 */
export function linkProblem(link, expect, from, to) {
  if (!link?.readable) return `the connections of ${from} could not be read`;
  if (expect === 'none') return link.total > 0 ? `${from} holds ${link.total} connection(s) to ${to}` : null;
  if (link.total === 0) return `${from} holds no connection to ${to}`;
  if (link.relayed !== link.total) return `${from} holds ${link.total - link.relayed} direct connection(s) to ${to}`;
  return null;
}

/**
 * The verdict of each case: FAIL when one of its checks failed, PASS when at
 * least one held and none failed, NOT RUN when nothing was checked (a case
 * that never ran is not a case that passed). `findings` maps a case id to
 * { pass: <count>, fail: [<text>] }.
 */
export function caseVerdicts(cases, findings) {
  const rows = Object.entries(cases).map(([id, title]) => {
    const f = findings[id] ?? { pass: 0, fail: [] };
    const verdict = f.fail.length ? 'FAIL' : f.pass > 0 ? 'PASS' : 'NOT RUN';
    return { id, title, verdict, held: f.pass, failed: f.fail.length };
  });
  return { rows, failed: rows.filter(row => row.verdict !== 'PASS').map(row => row.id) };
}
