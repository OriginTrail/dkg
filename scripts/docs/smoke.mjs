import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: {
  cli: { type: 'string', default: 'dkg' },
  'api-url': { type: 'string' },
  'allow-write': { type: 'boolean', default: false },
  share: { type: 'boolean', default: false },
} });
const run = (args, env = process.env) => execFileSync(values.cli, args, {
  cwd: root, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const commands = [
  ['init'], ['context-graph', 'create'], ['ka', 'create'], ['ka', 'write'],
  ['ka', 'query'], ['ka', 'finalize'], ['ka', 'share'], ['ka', 'extraction-status'],
  ['query'], ['okf', 'import'], ['okf', 'verify'], ['okf', 'export'],
  ['hermes', 'setup'], ['hermes', 'disconnect'], ['openclaw', 'setup'],
  ['prime-agent', 'setup'], ['prime-agent', 'verify'], ['prime-agent', 'disconnect'],
  ['mcp', 'setup'], ['mcp', 'uninstall'],
];
const help = new Map(commands.map(args => [args.join(' '), run([...args, '--help'])]));
for (const [name, output] of help) assert.match(output, /Usage:/, `${name}: expected command help`);
for (const [command, flag] of [
  ['init', '--network'], ['ka write', '--input-file'], ['query', '--include-shared-memory'],
  ['okf export', '--view'], ['hermes setup', '--preserve-provider'],
  ['prime-agent setup', '--agent-dir'], ['mcp setup', '--network'],
]) assert.ok(help.get(command).includes(flag), `${command}: missing documented flag ${flag}`);

const mapping = JSON.parse(run(['okf', 'import', 'examples/docs/okf-atlas', '--dry-run']));
assert.equal(mapping.conformant, true);
assert.equal(mapping.concepts, 2);
assert.equal(mapping.triples, 9);
assert.equal(mapping.linksResolved, 1);
assert.equal(mapping.linksBroken, 0);
const report = { version: run(['--version']).trim(), helpCommands: commands.length,
  okf: { concepts: mapping.concepts, triples: mapping.triples, links: mapping.linksResolved },
  live: 'not requested', excluded: ['framework conversations', 'peer replication', 'paid publication'] };

if (values['api-url']) {
  assert.ok(values['allow-write'], 'Live smoke creates sample graphs; pass --allow-write explicitly.');
  const base = new URL(values['api-url']);
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
    'Run against an isolated loopback node.');
  const token = process.env.DKG_DOCS_AUTH_TOKEN;
  assert.ok(token, 'Provide DKG_DOCS_AUTH_TOKEN without logging it.');
  async function request(path, body) {
    const response = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    assert.ok(response.ok && response.status !== 207 && !result.error &&
      (!result.errors || Object.keys(result.errors).length === 0), `Incomplete ${path}: HTTP ${response.status}`);
    return result;
  }
  const status = await request('/api/status');
  assert.equal(status.version, report.version, 'CLI and daemon versions must match for this test.');
  const created = await request('/api/context-graph/create', { id: `docs-smoke-${Date.now()}`, name: 'Documentation smoke' });
  assert.equal(typeof created.created, 'string', 'Creation must return the exact graph ID.');
  const cg = created.created;
  const appEnv = { ...process.env, DKG_AUTH_TOKEN: token, DKG_NODE_URL: base.href,
    DKG_CONTEXT_GRAPH: cg, DKG_KA_NAME: 'atlas-app' };
  const app = args => JSON.parse(execFileSync(process.execPath, ['examples/docs/http-app.mjs', ...args], {
    cwd: root, env: appEnv, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(app(['write']).count, 5);
  function assertAtlas(response) {
    const rows = response.result?.bindings;
    assert.equal(rows?.length, 1, 'Expected one evidence row');
    assert.equal(rows[0].project, '"Atlas"');
    assert.equal(rows[0].database, '"Oxigraph"');
    assert.equal(rows[0].source, 'https://example.org/dkg-tutorial/source');
  }
  assertAtlas(app(['read']));
  assertAtlas(app(['read'])); // Separate process; no client-side conversation state.
  if (values.share) {
    const result = app(['share']).result;
    assert.equal(result.swmShared, true);
    assert.equal(result.sealed, true);
    assertAtlas(app(['read', 'shared-working-memory']));
  }
  report.live = { graph: cg, wmTriples: 5, freshProcessRead: 'passed',
    sealAndLocalShare: values.share ? 'passed' : 'not requested' };
}
console.log(JSON.stringify(report, null, 2));
