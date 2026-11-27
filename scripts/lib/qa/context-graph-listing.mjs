// What a node's own listing (GET /api/context-graph/list) says about one
// context graph, for the devnet scripts that wait for a definition or have to
// know that a node does NOT follow a graph.
//
// The second use is the reason this is a module with tests. "This Core does
// not follow the graph" is a claim a scenario builds on; an answer that could
// not be read (an HTTP error, a body that is not the listing) is not that
// claim. Every reader gets one of three answers, and the third is never folded
// into the second:
//
//   subscription: following | not-following | unknown
//   definition:   defined   | undefined     | unknown
//
// A graph the listing does not hold is `not-following` / `undefined`: the node
// answered and does not know it. An entry whose `subscribed` is not a boolean
// is `unknown`.
//
// CLI (stdin: the frame devnet-lib's api() prints, the HTTP status on the first
// line and the body after it):
//   context-graph-listing.mjs subscription <contextGraphId>
//   context-graph-listing.mjs definition <contextGraphId>
// It prints the answer, with the reason after `unknown`, and exits 0 for
// following / defined, 1 for not-following / undefined, 2 for unknown.

import { pathToFileURL } from 'node:url';

const unknown = reason => ({ state: 'unknown', reason });

/** The listed graphs, or why the answer is not a listing. */
export function readListing(httpStatus, body) {
  if (!Number.isInteger(httpStatus) || httpStatus === 0) return { ok: false, reason: 'no answer' };
  if (httpStatus !== 200) return { ok: false, reason: `HTTP ${httpStatus}` };
  let answer;
  try { answer = JSON.parse(body); } catch { return { ok: false, reason: 'the body is not JSON' }; }
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.contextGraphs)) {
    return { ok: false, reason: 'the body has no contextGraphs list' };
  }
  if (answer.contextGraphs.some(graph => graph === null || typeof graph !== 'object' || typeof graph.id !== 'string')) {
    return { ok: false, reason: 'an entry of the list has no id' };
  }
  return { ok: true, graphs: answer.contextGraphs };
}

export function subscriptionState(httpStatus, body, contextGraphId) {
  const listing = readListing(httpStatus, body);
  if (!listing.ok) return unknown(listing.reason);
  const entries = listing.graphs.filter(graph => graph.id === contextGraphId);
  if (entries.some(graph => typeof graph.subscribed !== 'boolean')) return unknown('the entry does not say whether the node is subscribed');
  return { state: entries.some(graph => graph.subscribed) ? 'following' : 'not-following' };
}

/** A node knows a graph's access policy only from the graph's definition. */
export function definitionState(httpStatus, body, contextGraphId) {
  const listing = readListing(httpStatus, body);
  if (!listing.ok) return unknown(listing.reason);
  const defined = listing.graphs.some(graph => graph.id === contextGraphId
    && typeof graph.accessPolicy === 'string' && graph.accessPolicy !== '');
  return { state: defined ? 'defined' : 'undefined' };
}

/** `<status>\n<body>` as devnet-lib's api() prints it. */
export function parseFrame(frame) {
  const end = frame.indexOf('\n');
  const first = (end === -1 ? frame : frame.slice(0, end)).trim();
  return { httpStatus: /^[0-9]{3}$/.test(first) ? Number(first) : Number.NaN, body: end === -1 ? '' : frame.slice(end + 1) };
}

function main([question, contextGraphId]) {
  const reader = { subscription: subscriptionState, definition: definitionState }[question];
  if (!reader || !contextGraphId) throw new Error('usage: context-graph-listing.mjs <subscription|definition> <contextGraphId>');
  let frame = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { frame += chunk; });
  process.stdin.on('end', () => {
    const { httpStatus, body } = parseFrame(frame);
    const answer = reader(httpStatus, body, contextGraphId);
    console.log(answer.state === 'unknown' ? `unknown ${answer.reason}` : answer.state);
    process.exitCode = answer.state === 'unknown' ? 2 : ['following', 'defined'].includes(answer.state) ? 0 : 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
