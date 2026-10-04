import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseObservation, assertObservation, resultExit } from '../qa/query-observation.mjs';

const scripts = fileURLToPath(new URL('../..', import.meta.url));
const root = dirname(scripts);
const fixture = name => readFileSync(new URL(`./fixtures/query-observation/${name}.json`, import.meta.url), 'utf8');
const body = cell => JSON.stringify({ result: { type: 'bindings', bindings: [{ cnt: cell }] } });
const observe = (response, options = {}) => parseObservation({ transportExit: 0, httpStatus: 200, body: response, ...options });
const xsd = 'http://www.w3.org/2001/XMLSchema#';

for (const [name, response, options, expected] of [
  ['zero', body('0'), {}, '0'], ['positive', body('123'), {}, '123'],
  ['canonical zero', fixture('api-zero'), {}, '0'],
  ['large', fixture('api-large'), {}, '9007199254740993123456789'],
  ['SPARQL Results JSON', fixture('sparql-positive'), { format: 'sparql' }, '12'],
  ['legacy API typed object', body({ type: 'typed-literal', value: '+0012', datatype: `${xsd}integer` }), {}, '12'],
  ['unsignedLong', body(`"18446744073709551615"^^<${xsd}unsignedLong>`), {}, '18446744073709551615'],
  ['empty SELECT', '{"result":{"bindings":[]}}', { mode: 'rows' }, '0'],
]) test(`valid ${name}`, () => {
  const result = observe(response, options);
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.value, expected);
  assert.equal(resultExit(result), 0);
});

for (const [name, response, options, reason] of [
  ['curl failure', body('0'), { transportExit: 7 }, 'TRANSPORT_FAILURE'],
  ['HTTP error with zero', body('0'), { httpStatus: 503 }, 'HTTP_ERROR'],
  ['API error', fixture('api-error'), {}, 'API_ERROR'],
  ['error alongside bindings', '{"error":"denied","result":{"bindings":[{"cnt":"0"}]}}', {}, 'API_ERROR'],
  ['nested API error with empty SELECT', '{"result":{"bindings":[],"success":false}}', { mode: 'rows' }, 'API_ERROR'],
  ['nested API error with zero COUNT', '{"result":{"bindings":[{"cnt":"0"}],"status":"error"}}', {}, 'API_ERROR'],
  ['nested SPARQL error with empty SELECT', '{"head":{"vars":["s"]},"results":{"bindings":[],"error":"store unavailable"}}', { format: 'sparql', mode: 'rows', binding: 's' }, 'API_ERROR'],
  ['malformed JSON', '{', {}, 'MALFORMED_JSON'],
  ['missing result', '{}', {}, 'INVALID_RESULT'],
  ['wrong result type', '{"result":{"type":"boolean","bindings":[{"cnt":"0"}]}}', {}, 'INVALID_RESULT'],
  ['missing bindings', '{"result":{}}', {}, 'INVALID_BINDINGS'],
  ['wrong bindings', '{"result":{"bindings":{}}}', {}, 'INVALID_BINDINGS'],
  ['missing variable', '{"result":{"bindings":[{"c":"0"}]}}', {}, 'MISSING_BINDING'],
  ['no COUNT rows', '{"result":{"bindings":[]}}', {}, 'AMBIGUOUS_COUNT_ROWS'],
  ['multiple COUNT rows', '{"result":{"bindings":[{"cnt":"0"},{"cnt":"0"}]}}', {}, 'AMBIGUOUS_COUNT_ROWS'],
  ['bad SELECT row', '{"result":{"bindings":[null]}}', { mode: 'rows' }, 'INVALID_BINDINGS'],
  ['undeclared SPARQL variable', '{"head":{"vars":["cnt"]},"results":{"bindings":[{"x":"0"}]}}', { format: 'sparql' }, 'INVALID_BINDINGS'],
]) test(`invalid ${name} never satisfies zero`, () => {
  const result = observe(response, options);
  assert.equal(result.reason, reason);
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.equal(resultExit(assertObservation(result, 'eq', '0')), 2);
  assert.equal(result.value, undefined);
});

for (const cell of ['abc0xyz', '-1', '1.5', '1e3', '', 'NaN', '"0"@en', '"0"',
  `"0"^^<${xsd}string>`, `"0"^^<${xsd}positiveInteger>`, `"256"^^<${xsd}unsignedByte>`,
  0, 9007199254740992, null, { value: '0' }, { type: 'uri', value: '0' }]) {
  test(`reject count ${JSON.stringify(cell)}`, () => {
    const result = observe(body(cell));
    assert.equal(result.outcome, 'INCONCLUSIVE');
    assert.equal(resultExit(assertObservation(result, 'eq', '0')), 2);
  });
}

test('valid observation and assertion failure stay distinct with accurate large comparison', () => {
  const result = observe(fixture('api-large'));
  assert.equal(resultExit(assertObservation(result, 'ge', '9007199254740993123456788')), 0);
  assert.equal(resultExit(assertObservation(result, 'eq', '0')), 1);
});

function runShell(code, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-uo', 'pipefail', '-c', code], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// Execute the actual sharing functions and their actual parent-shell assignments.
// No reliance on set -e: it is intentionally absent, as in the shipping suite.
const sharingSource = readFileSync(join(scripts, 'devnet-test-sharing.sh'), 'utf8');
const sharingFunctions = sharingSource.slice(sharingSource.indexOf('query_api()'), sharingSource.indexOf('\nq() '));
for (const [name, response, http] of [
  ['API error', fixture('api-error'), 200], ['malformed', '{', 200],
  ['HTTP error', body('0'), 500], ['missing binding', body('0').replace('cnt', 'wrong'), 200],
  ['ambiguous COUNT', '{"result":{"bindings":[]}}', 200],
]) test(`parent sharing shell rejects ${name}`, async t => {
  const url = await serve(t, (_req, res) => { res.writeHead(http); res.end(response); });
  const captureAssignment = sharingSource.match(/^N1_VM=\$\(query_api[^\n]+\n[^\n]+/m)[0]
    .replace(/http:\/\/127\.0\.0\.1:\$\{N1_PORT\}\/api\/query/, `${url}/api/query`);
  const countAssignment = sharingSource.match(/^N1_VM_CT=\$\(count_integer[^\n]+/m)[0];
  const result = await runShell(`source "$HELPER"; AUTH=fixture; CG3_ID=fixture; ${sharingFunctions}\n${captureAssignment}\n${countAssignment}\n[ "$N1_VM_CT" = 0 ] && echo FALSE_PASS`, { HELPER: join(scripts, 'devnet-observation-helpers.sh') });
  assert.equal(result.status, 1, `parent status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
  assert.doesNotMatch(result.stdout, /FALSE_PASS/);
  assert.match(result.stderr, /INCONCLUSIVE/);
});

test('all sharing query and parser substitutions explicitly handle failure', () => {
  const assignments = sharingSource.match(/^\s*\w+=\$\((?:query_api|storage_query|safe_bindings_count|count_integer)[^\n]*(?:\n[^\n]*)?/gm);
  assert.ok(assignments.length > 90);
  for (const assignment of assignments) {
    const end = assignment.indexOf(')');
    // Bodies can contain parentheses, so check the complete one/two-line call.
    assert.ok(end > 0);
    assert.match(assignment, /\|\| devnet_observation_abort/, assignment);
  }
});

test('real wrapper transport failure has empty stdout and exit 2 even in a pipeline', async () => {
  const result = await runShell('source "$HELPER"; if value=$(devnet_capture http://127.0.0.1:1 | devnet_observe count cnt api); then echo FALSE_PASS; else exit $?; fi', { HELPER: join(scripts, 'devnet-observation-helpers.sh') });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /TRANSPORT_FAILURE/);
});

test('ACL empty API view cannot prove physical absence; raw seeded backend catches the leak', async t => {
  const url = await serve(t, (req, res) => {
    req.resume();
    if (req.url === '/api/query') res.end('{"result":{"type":"bindings","bindings":[]}}');
    else res.end('{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"uri","value":"urn:seeded-private-assertion"}}]}}');
  });
  const dir = mkdtempSync(join(root, '.qa-observer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node1'));
  writeFileSync(join(dir, 'node1/config.json'), JSON.stringify({ apiPort: Number(new URL(url).port), chain: { chainId: 'evm:31337', rpcUrl: url }, store: { backend: 'sparql-http', options: { queryEndpoint: `${url}/query` } } }));
  const result = await runShell(`source "$HELPER"
api=$(devnet_capture "$URL/api/query") || exit 2
visible=$(printf '%s' "$api" | devnet_observe rows s api) || exit 2
[ "$visible" = 0 ] || exit 1
physical=$(devnet_storage_query "$DIRECTORY" "$URL/api/query" '{"sparql":"SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }"}') || exit 2
printf '0\\n200\\n%s' "$physical" | devnet_observe rows s api eq 0`, { HELPER: join(scripts, 'devnet-observation-helpers.sh'), URL: url, DIRECTORY: dir });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ASSERTION_FAILED/);
});

test('storage absence refuses an empty positive control', async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.end('{"head":{"vars":["s"]},"results":{"bindings":[]}}'); });
  const dir = mkdtempSync(join(root, '.qa-observer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, 'node1'));
  writeFileSync(join(dir, 'node1/config.json'), JSON.stringify({ apiPort: Number(new URL(url).port), chain: { chainId: 'evm:31337', rpcUrl: url }, store: { backend: 'sparql-http', options: { queryEndpoint: `${url}/query` } } }));
  const result = await runShell('source "$HELPER"; devnet_storage_query "$DIRECTORY" "$URL/api/query" \'{"sparql":"SELECT ?s WHERE {?s ?p ?o}"}\'', { HELPER: join(scripts, 'devnet-observation-helpers.sh'), URL: url, DIRECTORY: dir });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
});

const rcSource = readFileSync(join(scripts, 'v10-rc-validation.sh'), 'utf8');
for (const [name, response, http] of [['API error', fixture('api-error'), 200], ['malformed', '{', 200], ['HTTP error', '{"result":{"bindings":[]}}', 500]]) {
  test(`RC smoke parent rejects ${name} on an absence assertion`, async t => {
    const url = await serve(t, (req, res) => { req.resume(); res.writeHead(http); res.end(response); });
    const queryPost = rcSource.slice(rcSource.indexOf('query_post()'), rcSource.indexOf('\nhttp_code()'));
    const assignment = rcSource.match(/    BINDINGS=\$\(query_post[^\n]+\n(?:[^\n]*\n){2}[^\n]+/)[0];
    const result = await runShell(`source "$HELPER"; H='Authorization: fixture'; PORT="$PORT"; CG=fixture; BOB_URI=urn:fixture; ${queryPost}\n${assignment}\n[ "$BINDINGS" = 0 ] && echo FALSE_PASS`, {
      HELPER: join(scripts, 'devnet-observation-helpers.sh'), PORT: new URL(url).port,
    });
    assert.equal(result.status, 1, result.stderr); assert.doesNotMatch(result.stdout, /FALSE_PASS/);
  });
}

const phonebookSource = readFileSync(join(scripts, 'devnet-probe-cg-phonebook.sh'), 'utf8');
for (const [name, response, expected] of [
  ['valid positive', body('12').replace('cnt', 'n'), 0],
  ['missing COUNT', '{"result":{"bindings":[]}}', 1],
  ['digit-containing garbage', body('broken12count').replace('cnt', 'n'), 1],
]) test(`phonebook parent handles ${name}`, async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.end(response); });
  const segment = phonebookSource.slice(phonebookSource.indexOf('MA_QUERY='), phonebookSource.indexOf('# --- 3.'));
  const result = await runShell(`source "$HELPER"; AUTH_HEADER='Authorization: fixture'; API_PORT_BASE="$PORT"; ok(){ echo PASS; }; fail(){ exit 1; }; ${segment}`, {
    HELPER: join(scripts, 'devnet-observation-helpers.sh'), PORT: new URL(url).port,
  });
  assert.equal(result.status, expected, result.stderr);
  if (expected === 1) assert.doesNotMatch(result.stdout, /PASS/);
});

const inviteSource = readFileSync(join(scripts, 'devnet-test-invite-flow.sh'), 'utf8');
test('invite-flow parent rejects API error on outsider absence check', async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.end(fixture('api-error')); });
  const segment = inviteSource.slice(inviteSource.indexOf('outside_query='), inviteSource.indexOf('\ncurator_live_count='));
  const result = await runShell(`source "$HELPER"; TOKEN=fixture; query_body='{}'; N3="$URL"; ok(){ echo FALSE_PASS; }; fail(){ exit 1; }; ${segment}`, {
    HELPER: join(scripts, 'devnet-observation-helpers.sh'), URL: url,
  });
  assert.equal(result.status, 1, result.stderr); assert.doesNotMatch(result.stdout, /FALSE_PASS/);
});

test('Bash threshold helper compares large decimal values accurately', async () => {
  const result = await runShell('source "$HELPER"; devnet_count_at_least 9007199254740993123456789 9007199254740993123456788', { HELPER: join(scripts, 'devnet-observation-helpers.sh') });
  assert.equal(result.status, 0);
});

for (const cell of ['', { type: 'uri', value: '' }, { type: 'uri', value: 'invalid URI' }]) {
  test(`malformed raw SELECT cell cannot satisfy the positive control: ${JSON.stringify(cell)}`, () => {
    const result = observe(JSON.stringify({ head: { vars: ['s'] }, results: { bindings: [{ s: cell }] } }), { format: 'sparql', mode: 'rows', binding: 's' });
    assert.equal(result.outcome, 'INCONCLUSIVE');
    assert.equal(resultExit(assertObservation(result, 'ge', '1')), 2);
  });
}

test('sharing owner control sees current numeric WM graphs as well as legacy assertion graphs', async t => {
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => {
      const query = new URLSearchParams(input).get('query');
      if (query.includes('LIMIT 1')) res.end('{"head":{"vars":["s"]},"results":{"bindings":[{"s":{"type":"uri","value":"urn:seeded"}}]}}');
      else res.end(JSON.stringify({ head: { vars: ['g'] }, results: { bindings: query.includes('/_working_memory/')
        ? [{ g: { type: 'uri', value: 'did:dkg:context-graph:fixture/_working_memory/0xabc/0' } }] : [] } }));
    });
  });
  const dir = mkdtempSync(join(root, '.qa-observer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, 'node1'));
  writeFileSync(join(dir, 'node1/config.json'), JSON.stringify({ apiPort: Number(new URL(url).port), chain: { chainId: 'evm:31337', rpcUrl: url }, store: { backend: 'sparql-http', options: { queryEndpoint: `${url}/query` } } }));
  const segment = sharingSource.slice(sharingSource.indexOf('OWNER_ASSERTIONS='), sharingSource.indexOf('\n\n\n#---', sharingSource.indexOf('OWNER_ASSERTIONS=')));
  const result = await runShell(`source "$HELPER"; DEVNET_DIR="$DIRECTORY"; N1_PORT="$PORT"; CG_ID=fixture; fail(){ exit 1; }; ${sharingFunctions}\n${segment}`, {
    HELPER: join(scripts, 'devnet-observation-helpers.sh'), DIRECTORY: dir, PORT: new URL(url).port,
  });
  assert.equal(result.status, 0, result.stderr);
});
