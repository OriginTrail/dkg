import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The rule this file pins: a devnet without a node on Blazegraph FAILS the
// content-shapes script. It is the configuration in which a store that returns
// a literal in another form went unseen, so a skip there would be a false pass.
const SCRIPT = fileURLToPath(new URL('../../devnet-test-issue-3198-content-shapes.sh', import.meta.url));

/**
 * A devnet reduced to what the store check reads: one HTTP listener per node
 * that answers GET /api/status, on consecutive ports as devnet-lib addresses
 * them. `storeAnswers` decides what a node's own store endpoint says.
 */
async function fakeDevnet(t, backends, { storeAnswers = 200 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-content-shapes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    const servers = [];
    try {
      for (const [i, backend] of backends.entries()) {
        const port = base + i;
        const server = createServer((req, res) => {
          if (req.url === '/api/status') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              storeBackend: backend, nodeRole: i === 0 ? 'core' : 'edge',
              storeUrl: backend === 'blazegraph' ? `http://127.0.0.1:${port}/store/sparql` : null,
            }));
          } else if (req.url.startsWith('/store/sparql')) {
            res.statusCode = storeAnswers; res.end('{}');
          } else { res.statusCode = 500; res.end('{}'); }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        servers.push(server);
        mkdirSync(join(dir, `node${i + 1}`), { recursive: true });
        writeFileSync(join(dir, `node${i + 1}`, 'auth.token'), '# fixture\nfixture-only\n');
      }
      t.after(() => { for (const server of servers) server.close(); });
      return { dir, base };
    } catch (error) {
      for (const server of servers) server.close();
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free port range for the fake devnet');
}

function storeCheck({ dir, base }, nodes, env = {}) {
  const child = spawn('bash', [SCRIPT], {
    env: {
      ...process.env, DEVNET_DIR: dir, API_PORT_BASE: String(base), NUM_NODES: String(nodes),
      CONTENT_SHAPES_STORES_ONLY: '1', DKG_AUTH: '', CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH: '', ...env,
    },
  });
  let output = '';
  child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, output })); });
}

test('a devnet without a Blazegraph node fails the script, and the report names every store', async t => {
  const devnet = await fakeDevnet(t, ['oxigraph-server', 'oxigraph', 'sparql-http']);
  const { status, output } = await storeCheck(devnet, 3);
  assert.equal(status, 1, output);
  assert.match(output, /Stores: node1=oxigraph-server\(core\) node2=oxigraph\(edge\) node3=sparql-http\(edge\)/);
  assert.match(output, /\[FAIL\] no node of this devnet runs Blazegraph/);
  assert.doesNotMatch(output, /SKIP/);
});

test('the opt-out must be explicit, and the report still says what was not covered', async t => {
  const devnet = await fakeDevnet(t, ['oxigraph-server', 'oxigraph']);
  const { status, output } = await storeCheck(devnet, 2, { CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH: '1' });
  assert.equal(status, 0, output);
  assert.match(output, /\[NOTE\] NO node runs Blazegraph .* NOT covered by this run/);
  // Any other value of the variable is not an opt-out.
  for (const value of ['0', 'true', 'yes']) {
    assert.equal((await storeCheck(devnet, 2, { CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH: value })).status, 1, value);
  }
});

test('a Blazegraph node counts only when its store answers', async t => {
  const up = await fakeDevnet(t, ['oxigraph-server', 'blazegraph']);
  const answered = await storeCheck(up, 2);
  assert.equal(answered.status, 0, answered.output);
  assert.match(answered.output, /Stores: node1=oxigraph-server\(core\) node2=blazegraph\(edge\)/);
  assert.match(answered.output, /\[PASS\] node2 runs Blazegraph and its store answers/);

  const down = await fakeDevnet(t, ['oxigraph-server', 'blazegraph'], { storeAnswers: 503 });
  const refused = await storeCheck(down, 2);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.output, /\[FAIL\] node2 is configured for Blazegraph but its store does not answer \(HTTP 503\)/);
});

test('a node that does not answer is a failure, not a smaller devnet', async t => {
  const devnet = await fakeDevnet(t, ['oxigraph-server', 'blazegraph']);
  // Three nodes are expected, two exist.
  const { status, output } = await storeCheck(devnet, 3);
  assert.equal(status, 1, output);
  assert.match(output, /\[FAIL\] node\(s\) 3 did not answer \/api\/status/);
});
