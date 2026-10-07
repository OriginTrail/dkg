import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../..', import.meta.url));
const helper = join(scripts, 'devnet-publish-helpers.sh');

function runShell(code, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-uo', 'pipefail', '-c', code], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
async function chain(t, answer) {
  const requests = [];
  const server = createServer((req, res) => {
    let input = ''; req.on('data', c => input += c);
    req.on('end', () => { const body = JSON.parse(input); requests.push(body); res.end(JSON.stringify(answer(body))); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: String(server.address().port), requests };
}
const mine = (count, port) => runShell(`source "$HELPER"; devnet_mine_blocks ${count} "$PORT"`, { HELPER: helper, PORT: port });
const mined = body => body.map(call => ({ jsonrpc: '2.0', id: call.id, result: '0x0' }));

test('devnet_mine_blocks mines one block per call in a single batch', async t => {
  const { port, requests } = await chain(t, mined);
  const result = await mine(3, port);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
  assert.deepEqual(requests, [[1, 2, 3].map(id => ({ jsonrpc: '2.0', id, method: 'evm_mine', params: [] }))]);
});

test('devnet_mine_blocks takes the port from HARDHAT_PORT when none is given', async t => {
  const { port, requests } = await chain(t, mined);
  const result = await runShell('source "$HELPER"; devnet_mine_blocks 2', { HELPER: helper, HARDHAT_PORT: port });
  assert.equal(result.status, 0, result.stderr); assert.equal(requests[0].length, 2);
});

for (const [name, answer] of [
  ['one call answered with an error', body => body.map((call, i) => i === 1
    ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'refused' } }
    : { jsonrpc: '2.0', id: call.id, result: '0x0' })],
  ['fewer answers than calls', body => mined(body).slice(1)],
  ['a single object in place of the batch', () => ({ jsonrpc: '2.0', id: 1, result: true })],
  ['an answer without a result', body => body.map(call => ({ jsonrpc: '2.0', id: call.id }))],
]) test(`devnet_mine_blocks fails on ${name}`, async t => {
  const { port } = await chain(t, answer);
  assert.equal((await mine(3, port)).status, 1);
});

test('devnet_mine_blocks refuses a count it cannot mine, without a request', async t => {
  const { port, requests } = await chain(t, mined);
  for (const count of ['0', '-1', '2.5', 'many', '5001']) assert.equal((await mine(count, port)).status, 2, count);
  assert.equal(requests.length, 0);
});

test('devnet_mine_blocks fails when the chain is not reachable', async () => {
  assert.equal((await mine(1, '1')).status, 1);
});

// For the blocks inside a hardhat_mine range the local chain answers a historical state read as if the
// contract did not exist, which sends a node's deployment-block search to the end of that range.
test('no devnet script mines with hardhat_mine', () => {
  const callers = readdirSync(scripts).filter(name => name.endsWith('.sh'))
    .filter(name => /"method"\s*:\s*\\?"hardhat_mine/.test(readFileSync(join(scripts, name), 'utf8').replace(/\\"/g, '"')));
  assert.deepEqual(callers, []);
});
