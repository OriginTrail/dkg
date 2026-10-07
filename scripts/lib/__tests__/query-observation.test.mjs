import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

// Exercise the operations called by the executable suites without loading
// startup state or depending on source formatting/assignment counts.
const helper = join(scripts, 'devnet-observation-helpers.sh');
const sharing = join(scripts, 'devnet-sharing-helpers.sh');
const privacy = join(scripts, 'devnet-privacy-helpers.sh');
const sharingSetup = `source "$SHARING"; PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  [PASS] $1"; }
fail(){ FAIL=$((FAIL+1)); echo "  [FAIL] $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected=$3, got=$2)"; fi; }
`;
const empty = '{"result":{"type":"bindings","bindings":[]}}';
const select = 'SELECT ?s WHERE { ?s ?p ?o }';
const count = 'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }';

for (const [name, response, http] of [
  ['API error', fixture('api-error'), 200], ['malformed', '{', 200],
  ['HTTP error', body('0'), 500], ['missing binding', body('0').replace('cnt', 'wrong'), 200],
  ['ambiguous COUNT', empty, 200],
]) test(`parent sharing shell rejects ${name}`, async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.writeHead(http); res.end(response); });
  const result = await runShell(`${sharingSetup} AUTH=fixture
value=$(sharing_api_observe "$PORT" "$QUERY" cnt count '{"contextGraphId":"fixture"}') || devnet_observation_abort
[ "$value" = 0 ] && echo FALSE_PASS`, { SHARING: sharing, PORT: new URL(url).port, QUERY: count });
  assert.equal(result.status, 1, `parent status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
  assert.doesNotMatch(result.stdout, /FALSE_PASS/);
  assert.match(result.stderr, /INCONCLUSIVE/);
});

for (const [name, response, http, expected] of [
  ['valid denied empty SELECT', empty, 200, 0],
  ['HTTP error', empty, 503, 1], ['malformed response', '{', 200, 1],
  ['API error', fixture('api-error'), 200, 1],
  ['visible leak', '{"result":{"bindings":[{"s":"<urn:leaked>"}]}}', 200, 1],
]) test(`sharing excluded SWM check handles ${name}`, async t => {
  let request;
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => { request = JSON.parse(input); res.writeHead(http); res.end(response); });
  });
  const result = await runShell(`${sharingSetup} AUTH=fixture; sharing_excluded_swm "$PORT" fixture; exit "$FAIL"`, {
    SHARING: sharing, PORT: new URL(url).port,
  });
  assert.equal(result.status, expected, result.stderr);
  assert.equal(request.sparql, select);
  assert.equal(request.contextGraphId, 'fixture'); assert.equal(request.view, 'shared-working-memory');
  if (expected === 0) assert.match(result.stdout, /\[PASS\] Node 3 still has 0 SWM entities/);
  else assert.doesNotMatch(result.stdout, /\[PASS\]/);
});

test('JSON-mode assertion preserves validated bindings and failures emit no payload', async () => {
  const rows = [{ s: '<urn:fixture>' }];
  const frame = `0\n200\n${JSON.stringify({ result: { type: 'bindings', bindings: rows } })}`;
  const success = await runShell('source "$HELPER"; printf "%s" "$FRAME" | devnet_observe json s api ge 1', { HELPER: helper, FRAME: frame });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout).result.bindings, rows);
  const failure = await runShell('source "$HELPER"; printf "%s" "$FRAME" | devnet_observe json s api eq 0', { HELPER: helper, FRAME: frame });
  assert.equal(failure.status, 1); assert.equal(failure.stdout, ''); assert.match(failure.stderr, /ASSERTION_FAILED/);
});

test('direct API metrics preserve scope and large integers in one observation', async t => {
  let request;
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => { request = JSON.parse(input); res.end(fixture('api-large')); });
  });
  const result = await runShell(`source "$HELPER"; devnet_query_api "$URL" fixture "$QUERY" cnt count '{"contextGraphId":"fixture","view":"shared-working-memory"}'`, {
    HELPER: helper, URL: url, QUERY: count,
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '9007199254740993123456789');
  assert.deepEqual(request, { contextGraphId: 'fixture', view: 'shared-working-memory', sparql: count });
});

const settling = JSON.stringify({ error: 'temporarily unavailable', code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true });
const settlingCall = (mode = 'rows', binding = 's') => `source "$HELPER"; devnet_query_api_settling "$URL" fixture "$QUERY" ${binding} ${mode} '{"contextGraphId":"fixture"}'`;

test('a settling poll reads the documented retryable 503 as nothing yet', async t => {
  let request;
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => { request = JSON.parse(input); res.writeHead(503, { 'Retry-After': '3' }); res.end(settling); });
  });
  const result = await runShell(settlingCall(), { HELPER: helper, URL: url, QUERY: select });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '0\n');
  assert.deepEqual(request, { contextGraphId: 'fixture', sparql: select });
});

for (const [name, http, response] of [
  ['a 503 with another code', 503, JSON.stringify({ error: 'busy', code: 'STORE_SCHEDULER_BUSY', retryable: true })],
  ['the same code without the retryable mark', 503, JSON.stringify({ error: 'x', code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE' })],
  ['the same body under another status', 500, settling],
  ['a 503 that is not JSON', 503, 'Service Unavailable'],
]) test(`a settling poll still rejects ${name}`, async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.writeHead(http); res.end(response); });
  const result = await runShell(settlingCall(), { HELPER: helper, URL: url, QUERY: select });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /HTTP_ERROR/);
});

test('a settling poll answers like the plain observation once the read is served', async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.end(fixture('api-large')); });
  const result = await runShell(settlingCall('count', 'cnt'), { HELPER: helper, URL: url, QUERY: count });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '9007199254740993123456789');
});

test('a settling poll refuses a mode that has no nothing-yet value, before any request', async t => {
  let requests = 0;
  const url = await serve(t, (req, res) => { requests += 1; req.resume(); res.end(empty); });
  const result = await runShell(settlingCall('bindings'), { HELPER: helper, URL: url, QUERY: select });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.equal(requests, 0);
});

test('the sharing wait loops use the settling poll and single observations stay strict', async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.writeHead(503); res.end(settling); });
  const port = new URL(url).port;
  const polled = await runShell(`${sharingSetup} AUTH=fixture
value=$(sharing_api_observe_settling "$PORT" "$QUERY" s rows '{"contextGraphId":"fixture"}') || devnet_observation_abort
echo "value=$value"`, { SHARING: sharing, PORT: port, QUERY: select });
  assert.equal(polled.status, 0, polled.stderr); assert.match(polled.stdout, /value=0/);
  const single = await runShell(`${sharingSetup} AUTH=fixture
value=$(sharing_api_observe "$PORT" "$QUERY" s rows '{"contextGraphId":"fixture"}') || devnet_observation_abort
echo "value=$value"`, { SHARING: sharing, PORT: port, QUERY: select });
  assert.equal(single.status, 1); assert.doesNotMatch(single.stdout, /value=/);
});

test('real wrapper transport failure has empty stdout and exit 2 even in a pipeline', async () => {
  const result = await runShell('source "$HELPER"; if value=$(devnet_capture http://127.0.0.1:1 | devnet_observe count cnt api); then echo FALSE_PASS; else exit $?; fi', { HELPER: helper });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /TRANSPORT_FAILURE/);
});

const raw = (binding, rows) => JSON.stringify({ head: { vars: [binding] }, results: { bindings: rows } });
const seeded = [{ s: { type: 'uri', value: 'urn:seeded-private-assertion' } }];
function config(port, endpoint) {
  return { apiPort: port, chain: { chainId: 'evm:31337', rpcUrl: 'http://127.0.0.1:18547' }, store: { backend: 'sparql-http', options: { queryEndpoint: endpoint } } };
}
function directory(t, configs, parent = root) {
  const dir = mkdtempSync(join(parent, '.qa-observer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  configs.forEach((value, i) => {
    mkdirSync(join(dir, `node${i + 1}`));
    writeFileSync(join(dir, `node${i + 1}/config.json`), JSON.stringify(value));
  });
  return dir;
}

for (const [name, owner, peer, expected] of [
  ['seeded owner and empty peer', seeded, [], 0],
  ['empty owner', [], [], 1], ['seeded peer leak', seeded, seeded, 1],
]) test(`paired physical absence handles ${name}`, async t => {
  const requests = [];
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => {
      const query = new URLSearchParams(input).get('query'); requests.push({ path: req.url, query });
      res.end(raw('s', query.includes('LIMIT 1') ? seeded : req.url === '/owner' ? owner : peer));
    });
  });
  const dir = directory(t, [config(19401, `${url}/owner`), config(19402, `${url}/peer`)]);
  const result = await runShell(`${sharingSetup} sharing_storage_absence 'Peer has no seeded fact' 19401 19402 "$QUERY" s; exit "$FAIL"`, {
    SHARING: sharing, DEVNET_DIR: dir, QUERY: select,
  });
  assert.equal(result.status, expected, result.stderr);
  assert.deepEqual(requests.filter(r => !r.query.includes('LIMIT 1')).map(r => r.query), owner.length ? [select, select] : [select]);
  assert.deepEqual(requests.map(r => r.path), owner.length ? ['/owner', '/owner', '/peer', '/peer'] : ['/owner', '/owner']);
  if (!owner.length) assert.match(result.stdout, /Owner storage control did not expose the seeded WM fact/);
});

test('ACL empty API view cannot prove physical absence; raw seeded backend catches the leak', async t => {
  const url = await serve(t, (req, res) => { req.resume(); res.end(req.url === '/api/query' ? empty : raw('s', seeded)); });
  const dir = directory(t, [config(19401, `${url}/query`)]);
  const result = await runShell(`source "$HELPER"
visible=$(devnet_query_api "$URL" fixture "$QUERY" s rows) || exit 2
[ "$visible" = 0 ] || exit 1
devnet_storage_query "$DIRECTORY" 19401 "$QUERY" s rows eq 0`, { HELPER: helper, URL: url, DIRECTORY: dir, QUERY: select });
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /ASSERTION_FAILED/);
});

test('storage absence refuses an empty positive control before acquiring the observation', async t => {
  let calls = 0;
  const url = await serve(t, (req, res) => { req.resume(); calls++; res.end(raw('s', [])); });
  const dir = directory(t, [config(19401, `${url}/query`)]);
  const result = await runShell('source "$HELPER"; devnet_storage_query "$DIRECTORY" 19401 "$QUERY" s rows', { HELPER: helper, DIRECTORY: dir, QUERY: select });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.equal(calls, 1);
});

test('explicit raw COUNT binding supports expression projections without inferring SPARQL text', async t => {
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => res.end(new URLSearchParams(input).get('query').includes('LIMIT 1') ? raw('s', seeded)
      : raw('cnt', [{ cnt: { type: 'literal', value: '9007199254740993123456789', datatype: `${xsd}integer` } }])));
  });
  const dir = directory(t, [config(19401, `${url}/query`)]);
  const result = await runShell('source "$HELPER"; devnet_storage_query "$DIRECTORY" 19401 "$QUERY" cnt count', { HELPER: helper, DIRECTORY: dir, QUERY: count });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '9007199254740993123456789');
});

async function rejectsBeforeAcquisition(dir) {
  const endpoint = await runShell('node "$RESOLVER" "$DIRECTORY" http://127.0.0.1:19401', {
    RESOLVER: join(scripts, 'lib/qa/devnet-storage-endpoint.mjs'), DIRECTORY: dir,
  });
  assert.equal(endpoint.status, 2); assert.equal(endpoint.stdout, '');
  const observation = await runShell('source "$HELPER"; curl(){ echo ACQUIRED >&2; return 99; }; devnet_storage_query "$DIRECTORY" 19401 "$QUERY" s rows', {
    HELPER: helper, DIRECTORY: dir, QUERY: select,
  });
  assert.equal(observation.status, 2); assert.equal(observation.stdout, ''); assert.doesNotMatch(observation.stderr, /ACQUIRED/);
}

for (const [name, change] of [
  ['API port mismatch', c => { c.apiPort = 19402; }],
  ['non-devnet chain', c => { c.chain.chainId = 'evm:8453'; }],
  ['non-loopback RPC', c => { c.chain.rpcUrl = 'http://192.0.2.1:8545'; }],
  ['non-loopback store', c => { c.store.options.queryEndpoint = 'http://192.0.2.1:9999/query'; }],
  ['unsupported embedded store', c => { c.store = { backend: 'oxigraph', options: {} }; }],
]) test(`raw store boundary rejects ${name} without query acquisition`, async t => {
  const candidate = config(19401, 'http://127.0.0.1:17901/query'); change(candidate);
  const dir = directory(t, [candidate]);
  await rejectsBeforeAcquisition(dir);
});

for (const name of ['outside checkout', 'nested directory']) test(`raw store boundary rejects ${name} before acquisition`, async t => {
  const parent = name === 'outside checkout' ? tmpdir() : mkdtempSync(join(root, '.qa-parent-'));
  if (name === 'nested directory') t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = directory(t, [config(19401, 'http://127.0.0.1:17901/query')], parent);
  await rejectsBeforeAcquisition(dir);
});

test('endpoint resolver rejects a non-loopback API identity without emitting an endpoint', async t => {
  const dir = directory(t, [config(19401, 'http://127.0.0.1:17901/query')]);
  const result = await runShell('node "$RESOLVER" "$DIRECTORY" http://192.0.2.1:19401', { RESOLVER: join(scripts, 'lib/qa/devnet-storage-endpoint.mjs'), DIRECTORY: dir });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
});

for (const [operation, binding, predicate, scope, args] of [
  ['rc_private_peer_privacy', 'o', 'email', {}, '19402'],
  ['rc_publisher_privacy', 'o', 'email', {}, ''],
  ['rc_wm_privacy', 'name', 'name', {}, ''],
  ['rc_subgraph_root_isolation', 'name', 'name', {}, ''],
  ['invite_outsider_privacy', 'o', 'name', { graphSuffix: '_shared_memory' }, ''],
]) for (const [name, response, http, expected] of [
  ['valid empty', empty, 200, 0],
  ['leaked row', JSON.stringify({ result: { bindings: [{ [binding]: '"private"' }] } }), 200, 1],
  ['API error', fixture('api-error'), 200, 1], ['malformed', '{', 200, 1],
  ['HTTP error', empty, 500, 1],
  ['missing binding', '{"result":{"bindings":[{"wrong":"<urn:leak>"}]}}', 200, 1],
]) test(`actual ${operation} assertion handles ${name}`, async t => {
  let request;
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => { request = JSON.parse(input); res.writeHead(http); res.end(response); });
  });
  const result = await runShell(`source "$PRIVACY"; FAIL=0
ok(){ echo PASS; }
fail(){ FAIL=1; echo FAIL; [ "$OPERATION" != invite_outsider_privacy ] || exit 1; }
warn(){ echo WARN; }
"$OPERATION" "$URL" fixture urn:private fixture "$ARGUMENT"
exit "$FAIL"`, { PRIVACY: privacy, OPERATION: operation, URL: url, ARGUMENT: args });
  const advisory = operation === 'rc_subgraph_root_isolation' && name === 'leaked row';
  assert.equal(result.status, advisory ? 0 : expected, result.stderr);
  assert.deepEqual(request, { contextGraphId: 'fixture', ...scope,
    sparql: `SELECT ?${binding} WHERE { <urn:private> <http://schema.org/${predicate}> ?${binding} }` });
  if (advisory) assert.match(result.stdout, /WARN/);
  if (expected === 0) assert.match(result.stdout, /PASS/);
  else assert.doesNotMatch(result.stdout, /PASS/);
  if (name.includes('error') || name === 'malformed' || name === 'missing binding') assert.match(result.stderr, /INCONCLUSIVE/);
});

for (const [name, crossResponse, http, expected] of [
  ['valid positive', body('12').replace('cnt', 'n'), 200, 0],
  ['valid advisory zero', body('0').replace('cnt', 'n'), 200, 0],
  ['missing COUNT', empty, 200, 1],
  ['digit-containing garbage', body('broken12count').replace('cnt', 'n'), 200, 1],
  ['HTTP error', body('0').replace('cnt', 'n'), 503, 1],
]) test(`complete phonebook fixture script handles ${name}`, async t => {
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => {
      if (req.url === '/api/query') {
        const query = JSON.parse(input).sparql;
        const cross = query.includes('FILTER');
        res.writeHead(cross ? http : 200); res.end(cross ? crossResponse : body('12').replace('cnt', 'n'));
      } else res.end(JSON.stringify(req.url === '/api/identity' ? { hasIdentity: true } : { peerId: 'fixture-peer' }));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'dkg-phonebook-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let n = 1; n <= 6; n++) {
    mkdirSync(join(dir, `node${n}`)); writeFileSync(join(dir, `node${n}/daemon.log`), 'publishProfile succeeded\n');
  }
  writeFileSync(join(dir, 'node1/auth.token'), 'fixture-only');
  const result = await runShell(`curl(){
local args=() arg
for arg in "$@"; do
  if [[ "$arg" =~ ^http://127.0.0.1:[0-9]+(/.*)$ ]]; then arg="$URL\${BASH_REMATCH[1]}"; fi
  args+=("$arg")
done
command curl "\${args[@]}"
}
export -f curl
bash "$PROBE"`, { URL: url, DEVNET_DIR: dir, PROBE: join(scripts, 'devnet-probe-cg-phonebook.sh') });
  assert.equal(result.status, expected, result.stderr);
  if (expected === 0) assert.match(result.stdout, /Probe summary: PASS=\d+ FAIL=0/);
  else { assert.match(result.stderr, /INCONCLUSIVE/); assert.doesNotMatch(result.stdout, /Probe summary/); }
});

test('Bash threshold helper compares large decimal values accurately', async () => {
  const result = await runShell('source "$HELPER"; devnet_count_at_least 9007199254740993123456789 9007199254740993123456788', { HELPER: helper });
  assert.equal(result.status, 0);
});

for (const cell of ['', { type: 'uri', value: '' }, { type: 'uri', value: 'invalid URI' }]) {
  test(`malformed raw SELECT cell cannot satisfy the positive control: ${JSON.stringify(cell)}`, () => {
    const result = observe(raw('s', [{ s: cell }]), { format: 'sparql', mode: 'rows', binding: 's' });
    assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(resultExit(assertObservation(result, 'ge', '1')), 2);
  });
}

test('loading sharing operations preserves caller options and counters', async () => {
  const result = await runShell(`set +u; set +o pipefail
PASS=7; FAIL=8; WARN=9
before=$-; before_pipe=$(set -o | awk '$1 == "pipefail" { print $2 }')
source "$SHARING"
[ "$PASS,$FAIL,$WARN" = 7,8,9 ] && [ "$-" = "$before" ] &&
[ "$(set -o | awk '$1 == "pipefail" { print $2 }')" = "$before_pipe" ]`, { SHARING: sharing });
  assert.equal(result.status, 0, result.stderr);
});

// Resolve the already-installed storage engine through its owning workspace.
// No dependency or test route is added to the tooling lane.
const require = createRequire(new URL('../../../packages/storage/package.json', import.meta.url));
const oxigraph = require('oxigraph');
const numericGraph = 'did:dkg:context-graph:fixture/_working_memory/0xabc/0';
const legacyGraph = 'did:dkg:context-graph:fixture/assertion/old';
const unrelatedGraphs = ['did:dkg:context-graph:fixture/_shared_memory',
  'did:dkg:context-graph:other/_working_memory/0xabc/0'];

for (const [name, graphs, expectedGraphs] of [
  ['numeric-only WM', [numericGraph, ...unrelatedGraphs], [numericGraph]],
  ['numeric and legacy WM', [numericGraph, legacyGraph, ...unrelatedGraphs], [numericGraph, legacyGraph]],
]) test(`generated WM query and owner control execute against ${name} RDF`, async t => {
  const store = new oxigraph.Store();
  store.load(graphs.map(g => `<urn:private> <urn:predicate> <urn:object> <${g}> .`).join('\n'), { format: 'application/n-quads' });
  const generated = await runShell('source "$SHARING"; sharing_wm_graphs_query fixture', { SHARING: sharing });
  assert.equal(generated.status, 0, generated.stderr);
  const rows = store.query(generated.stdout);
  assert.deepEqual(rows.map(row => row.get('g').value).sort(), [...expectedGraphs].sort(), 'generated query selects only this context’s WM graphs');
  const requests = [];
  const url = await serve(t, (req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => {
      try {
        const query = new URLSearchParams(input).get('query'); requests.push(query);
        const result = store.query(query);
        const vars = [...new Set(result.flatMap(row => [...row.keys()]))];
        const bindings = result.map(row => Object.fromEntries([...row].map(([key, term]) => [key, { type: 'uri', value: term.value }])));
        res.end(JSON.stringify({ head: { vars }, results: { bindings } }));
      } catch { res.writeHead(400); res.end('invalid SPARQL'); }
    });
  });
  const dir = directory(t, [config(19401, `${url}/query`)]);
  const result = await runShell(`${sharingSetup} sharing_owner_wm_control 19401 fixture`, { SHARING: sharing, DEVNET_DIR: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], generated.stdout.trim());
});
