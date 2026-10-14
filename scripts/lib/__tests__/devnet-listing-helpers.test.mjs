import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { definitionState, parseFrame, readListing, subscriptionState } from '../qa/context-graph-listing.mjs';

// The rule this file pins: "this node does not follow the graph" is only ever
// concluded from a listing that was read. An answer that could not be read is
// `unknown`, and nothing built on these helpers may take `unknown` for "no".
const CLI = fileURLToPath(new URL('../qa/context-graph-listing.mjs', import.meta.url));
const HELPERS = fileURLToPath(new URL('../../devnet-listing-helpers.sh', import.meta.url));
const CG = '0xabc/relay-graph';
const listing = (...graphs) => JSON.stringify({ contextGraphs: graphs });
const entry = (subscribed, extra = {}) => ({ id: CG, subscribed, ...extra });
const other = { id: 'devnet-test', subscribed: true, accessPolicy: 'public' };

// Every way a node's answer can fail to be a listing.
const unreadable = [
  ['an HTTP error with a body', 500, '{"error":"store unavailable"}', 'HTTP 500'],
  ['the retryable 503 of a node that is settling', 503, '{"code":"CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE","retryable":true}', 'HTTP 503'],
  ['no answer at all', 0, '', 'no answer'],
  ['a body that is not JSON', 200, '<html>bad gateway</html>', 'the body is not JSON'],
  ['a truncated body', 200, '{"contextGraphs":[{"id":"0xabc/relay-gr', 'the body is not JSON'],
  ['a body without contextGraphs', 200, '{"result":[]}', 'the body has no contextGraphs list'],
  ['contextGraphs that is not a list', 200, '{"contextGraphs":{}}', 'the body has no contextGraphs list'],
  ['a JSON null', 200, 'null', 'the body has no contextGraphs list'],
  ['an entry without an id', 200, '{"contextGraphs":[{"subscribed":false}]}', 'an entry of the list has no id'],
];

test('a listing that was read answers following or not-following', () => {
  assert.deepEqual(subscriptionState(200, listing(other, entry(true)), CG), { state: 'following' });
  assert.deepEqual(subscriptionState(200, listing(other, entry(false)), CG), { state: 'not-following' });
  // The node answered and does not know the graph.
  assert.deepEqual(subscriptionState(200, listing(other), CG), { state: 'not-following' });
  assert.deepEqual(subscriptionState(200, listing(), CG), { state: 'not-following' });
  // Another graph's subscription says nothing about this one.
  assert.deepEqual(subscriptionState(200, listing({ ...other, id: `${CG}-2` }), CG), { state: 'not-following' });
});

test('an answer that could not be read is unknown, never not-following', () => {
  for (const [what, status, body, reason] of unreadable) {
    assert.deepEqual(subscriptionState(status, body, CG), { state: 'unknown', reason }, what);
    assert.deepEqual(definitionState(status, body, CG), { state: 'unknown', reason }, what);
    assert.equal(readListing(status, body).ok, false, what);
  }
  // An entry that does not say is not an entry that says no.
  for (const subscribed of [undefined, null, 'false', 0]) {
    assert.equal(subscriptionState(200, listing(entry(subscribed)), CG).state, 'unknown', String(subscribed));
  }
});

test('a node holds the definition when its entry carries the access policy', () => {
  assert.deepEqual(definitionState(200, listing(entry(true, { accessPolicy: 'public' })), CG), { state: 'defined' });
  // Subscribed, but the definition has not arrived: the entry is a bare id.
  assert.deepEqual(definitionState(200, listing(entry(true)), CG), { state: 'undefined' });
  assert.deepEqual(definitionState(200, listing(entry(true, { accessPolicy: '' })), CG), { state: 'undefined' });
  assert.deepEqual(definitionState(200, listing(other), CG), { state: 'undefined' });
});

test('the frame of api() is the status line and then the body', () => {
  assert.deepEqual(parseFrame('200\n{"contextGraphs":[]}'), { httpStatus: 200, body: '{"contextGraphs":[]}' });
  assert.deepEqual(parseFrame('000\n'), { httpStatus: 0, body: '' });
  assert.ok(Number.isNaN(parseFrame('').httpStatus));
  assert.ok(Number.isNaN(parseFrame('{"contextGraphs":[]}').httpStatus));
  assert.equal(subscriptionState(parseFrame('').httpStatus, '', CG).state, 'unknown');
});

test('the command line answers in words and with a status, and unknown is its own status', () => {
  const ask = (question, frame, id = CG) => spawnSync(process.execPath, [CLI, question, id], { input: frame, encoding: 'utf8' });
  const following = ask('subscription', `200\n${listing(entry(true))}`);
  assert.equal(following.status, 0); assert.equal(following.stdout.trim(), 'following');
  const not = ask('subscription', `200\n${listing(entry(false))}`);
  assert.equal(not.status, 1); assert.equal(not.stdout.trim(), 'not-following');
  for (const [what, status, body, reason] of unreadable) {
    const answer = ask('subscription', `${String(status).padStart(3, '0')}\n${body}`);
    assert.equal(answer.status, 2, what); assert.equal(answer.stdout.trim(), `unknown ${reason}`, what);
  }
  assert.equal(ask('definition', `200\n${listing(entry(true, { accessPolicy: 'public' }))}`).status, 0);
  assert.equal(ask('definition', `200\n${listing(entry(true))}`).status, 1);
  // A question it does not know, or no graph, is not an answer.
  assert.equal(ask('subscribed', `200\n${listing(entry(false))}`).status, 2);
  assert.equal(ask('subscription', `200\n${listing(entry(false))}`, '').status, 2);
});

/** The shell helpers with api() answering each node from a frame file. */
function shell(t, frames, script) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-listing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [node, frame] of Object.entries(frames)) writeFileSync(join(dir, `node${node}.frame`), frame);
  const result = spawnSync('bash', ['-c', `
    set -uo pipefail
    api() { cat "$FRAMES/node$1.frame" 2>/dev/null || printf '000\\n'; }
    source "$1"
    ${script}
  `, 'bash', HELPERS], { encoding: 'utf8', env: { ...process.env, FRAMES: dir, CG } });
  return (result.stdout + result.stderr).trim();
}
const FOLLOWING = 'status=0; devnet_following "$CG" 1 2 3 || status=$?; echo "status=$status following=[$DEVNET_FOLLOWING] unknown=[$DEVNET_FOLLOWING_UNKNOWN]"';
const out = `200\n${listing(other, entry(false))}`;
const absent = `200\n${listing(other)}`;
const inside = `200\n${listing(entry(true))}`;

test('nodes are kept out of a graph only when every one of them said so', t => {
  assert.equal(shell(t, { 1: out, 2: absent, 3: out }, FOLLOWING), 'status=0 following=[] unknown=[]');
  assert.equal(shell(t, { 1: out, 2: inside, 3: inside }, FOLLOWING), 'status=1 following=[ node2 node3] unknown=[]');
});

test('one node whose listing could not be read fails the check, whatever the others said', t => {
  for (const [what, status, body, reason] of unreadable) {
    const frame = `${String(status).padStart(3, '0')}\n${body}`;
    assert.equal(shell(t, { 1: out, 2: frame, 3: out }, FOLLOWING), `status=2 following=[] unknown=[ node2 (${reason})]`, what);
  }
  // A node that follows the graph does not turn an unread one into evidence, and the report names both.
  assert.equal(shell(t, { 1: inside, 2: '500\n{"error":"x"}', 3: out }, FOLLOWING), 'status=2 following=[ node1] unknown=[ node2 (HTTP 500)]');
  // A node that is not there at all.
  assert.equal(shell(t, { 1: out, 3: out }, FOLLOWING), 'status=2 following=[] unknown=[ node2 (no answer)]');
});

test('a reader that dies is not a node that said no', t => {
  // The status of a crashed reader is 1, the status of "not-following"; only the words tell them apart.
  const script = `devnet_listing() { return 1; }; ${FOLLOWING}`;
  assert.equal(shell(t, { 1: out, 2: out, 3: out }, script), 'status=2 following=[] unknown=[ node1 (no verdict) node2 (no verdict) node3 (no verdict)]');
  const silent = `devnet_listing() { return 0; }; ${FOLLOWING}`;
  assert.match(shell(t, { 1: out, 2: out, 3: out }, silent), /^status=2 following=\[\] unknown=\[ node1 \(no verdict\)/);
});

test('the definition wait sees a definition only in a listing that was read', t => {
  const ask = 'if devnet_has_definition 1 "$CG"; then echo "yes [$DEVNET_LISTING_ANSWER]"; else echo "no [$DEVNET_LISTING_ANSWER]"; fi';
  assert.equal(shell(t, { 1: `200\n${listing(entry(true, { accessPolicy: 'public' }))}` }, ask), 'yes [defined]');
  assert.equal(shell(t, { 1: `200\n${listing(entry(true))}` }, ask), 'no [undefined]');
  assert.equal(shell(t, { 1: '500\n{"error":"x"}' }, ask), 'no [unknown HTTP 500]');
  assert.equal(shell(t, {}, ask), 'no [unknown no answer]');
});
