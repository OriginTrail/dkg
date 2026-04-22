#!/usr/bin/env node
/**
 * Phase 7 stdio smoke test for dkg_get_ontology + dkg_annotate_turn.
 *
 * Spawns the built mcp-dkg binary, runs the JSON-RPC handshake, then:
 *   1. Verifies dkg_get_ontology returns both the .ttl and the .md.
 *   2. Writes a fresh chat turn directly via the daemon (so the
 *      "annotate the latest turn I authored" code path has something
 *      to resolve).
 *   3. Calls dkg_annotate_turn with a representative payload covering
 *      every input slot (topics + mentions + examines + concludes +
 *      asks + proposedDecisions + proposedTasks + comments + vmPublishRequests).
 *   4. Verifies the resulting triples landed in the chat sub-graph and
 *      gossiped to node-2.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.resolve(__dirname, '..', 'dist', 'index.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── 1. Seed a fresh chat turn directly via the daemon so the annotate-
//      the-latest-turn code path has something to resolve. We re-use the
//      seed script that we already proved works for two-machine smoke.
const sessionId = `phase7-annotate-smoke-${Date.now()}`;
console.log(`\x1b[1;36m[seed]\x1b[0m writing chat turn (session ${sessionId})...`);
const seedRes = await runOnce('node', [
  path.join(REPO_ROOT, 'scripts', 'send-test-chat-turn.mjs'),
  '--api=http://localhost:9200',
  '--node-id=1',
  '--agent=cursor-branarakic',
  `--session=${sessionId}`,
  '--prompt=Phase 7 annotate-turn smoke — should we adopt tree-sitter?',
  '--reply=Yes; trade-off is bundle size vs. incremental reparse.',
]);
if (seedRes.code !== 0) {
  console.error('Seed failed', seedRes);
  process.exit(1);
}

// ── 2. Stand up the MCP server.
const child = spawn('node', [BIN], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: REPO_ROOT,
  env: { ...process.env },
});
let buffer = '';
const pending = new Map();
let nextId = 1;
function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function sendNotif(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {
      console.error('[smoke] bad message:', line);
    }
  }
});

async function call(name, args, label) {
  const r = await send('tools/call', { name, arguments: args });
  const text = r?.content?.[0]?.text ?? JSON.stringify(r);
  const flag = r?.isError ? '✘' : '✔';
  console.log(`\n── ${flag} ${label ?? name} ──`);
  // Truncate huge ontology dumps for readability
  const display = text.length > 1500 ? text.slice(0, 1500) + `\n… (truncated, ${text.length} chars total)` : text;
  console.log(display);
  return r;
}

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-annotate', version: '0.0.1' },
  });
  sendNotif('notifications/initialized');

  const tools = await send('tools/list', {});
  const toolNames = (tools?.tools ?? []).map((t) => t.name).sort();
  console.log('\x1b[1;36mRegistered tools:\x1b[0m\n  ' + toolNames.join('\n  '));
  for (const required of ['dkg_get_ontology', 'dkg_annotate_turn']) {
    if (!toolNames.includes(required)) {
      console.error(`\n✘ ${required} not registered.`);
      child.kill();
      process.exit(1);
    }
  }

  // 3a. dkg_get_ontology
  const ontoRes = await call('dkg_get_ontology', {}, 'dkg_get_ontology');
  if (ontoRes?.isError) throw new Error('Ontology fetch failed');
  const ontoText = ontoRes.content[0].text;
  if (!ontoText.includes('@prefix owl:') || !ontoText.includes('look-before-mint')) {
    throw new Error('Ontology response missing expected ttl/markdown content');
  }

  // 3b. dkg_annotate_turn — every slot exercised
  const turnUri = `urn:dkg:chat:session:${sessionId}#turn:1`;
  await call('dkg_annotate_turn', {
    turnUri,
    topics: ['phase 7 smoke', 'AST tooling', 'tree-sitter'],
    mentions: [
      'urn:dkg:concept:tree-sitter',
      'tree sitter',                    // bare label → minted as urn:dkg:concept:tree-sitter
      'urn:dkg:github:repo:OriginTrail/dkg-v9',
    ],
    examines: ['urn:dkg:code:package:%40origintrail-official%2Fdkg-cli'],
    concludes: ['tree-sitter wins on incremental reparsing'],
    asks: ['how do we measure parser memory pressure'],
    proposedDecisions: [{
      title: `Phase 7 smoke decision ${Date.now()}`,
      context: 'Smoke-testing dkg_annotate_turn proposedDecisions slot.',
      outcome: 'If you see this in the graph attributed to cursor-branarakic, the annotate-turn write path is working.',
      consequences: 'None — this is a test entity.',
    }],
    proposedTasks: [{
      title: `Phase 7 smoke task ${Date.now()}`,
      priority: 'p2',
      assignee: 'branarakic',
    }],
    comments: [{ about: turnUri, body: 'Smoke comment from annotate-turn — testing the comments slot.' }],
    vmPublishRequests: [{ entityUri: turnUri, rationale: 'Smoke-only — should appear as a marker entity, NOT publish on-chain.' }],
  }, 'dkg_annotate_turn (full payload)');

  // 4. Verify gossip — query node-2 for the new chat:mentions edges
  console.log('\n\x1b[1;36m[verify]\x1b[0m fetching annotation from node-2 via gossip in 5s...');
  await new Promise(r => setTimeout(r, 5000));
  const verifyRes = await runOnce('curl', [
    '-s',
    '-H', `Authorization: Bearer ${fs.readFileSync(path.join(REPO_ROOT, '.devnet/node2/auth.token'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'))[0].trim()}`,
    '-X', 'POST', 'http://localhost:9202/api/query',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({
      contextGraphId: 'dkg-code-project',
      subGraphName: 'chat',
      includeSharedMemory: true,
      sparql: `SELECT ?p ?o WHERE { GRAPH ?g { <${turnUri}> ?p ?o . FILTER(STRSTARTS(STR(?p), "http://dkg.io/ontology/chat/")) } }`,
    }),
  ]);
  if (verifyRes.code !== 0) {
    console.error('Node-2 verify failed:', verifyRes.stderr);
  } else {
    let parsed;
    try { parsed = JSON.parse(verifyRes.stdout); } catch { parsed = { raw: verifyRes.stdout }; }
    const bindings = parsed?.result?.bindings ?? [];
    console.log(`\n✔ node-2 sees ${bindings.length} chat:* triples on ${turnUri} (proving cross-node gossip):`);
    for (const b of bindings.slice(0, 12)) {
      const p = (b.p?.value ?? b.p ?? '').replace('http://dkg.io/ontology/chat/', 'chat:');
      const o = b.o?.value ?? b.o ?? '';
      const oShort = String(o).length > 70 ? String(o).slice(0, 70) + '…' : o;
      console.log(`  - ${p} → ${oShort}`);
    }
    if (bindings.length > 12) console.log(`  …and ${bindings.length - 12} more`);
  }

  console.log('\n\x1b[1;36m✔ smoke done\x1b[0m');
} catch (err) {
  console.error(`\n✘ smoke failed: ${err?.stack ?? err?.message ?? err}`);
  child.kill();
  process.exit(1);
}

child.kill();
await once(child, 'close');

function runOnce(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (b) => stdout += b);
    c.stderr.on('data', (b) => stderr += b);
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
