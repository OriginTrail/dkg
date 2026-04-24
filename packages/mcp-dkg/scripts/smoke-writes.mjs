#!/usr/bin/env node
/**
 * Fast stdio smoke test for the dkg-mcp write tools. Spawns the built
 * binary, sends a minimal JSON-RPC handshake, calls each write tool
 * with a small payload, and prints the result. Non-intrusive to any
 * live MCP client (it launches a *separate* process).
 *
 * Usage:
 *   node packages/mcp-dkg/scripts/smoke-writes.mjs
 *
 * Set DKG_CONFIG pointing at a specific config file if you want to
 * target a different node/agent; otherwise the server walks up from
 * this script's cwd (usually the repo root, which picks up
 * .dkg/config.yaml → node1 + cursor-branarakic).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.resolve(__dirname, '..', 'dist', 'index.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
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
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function sendNotif(method, params) {
  const msg = { jsonrpc: '2.0', method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
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
    } catch (err) {
      console.error(`[smoke] bad message: ${line}`);
    }
  }
});

async function callTool(name, args) {
  const result = await send('tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text ?? JSON.stringify(result);
  const flag = result?.isError ? '✘' : '✔';
  console.log(`\n── ${flag} ${name} ──\n${text}`);
  return result;
}

const label = (s) => `\x1b[1;36m${s}\x1b[0m`;

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-writes', version: '0.0.1' },
  });
  sendNotif('notifications/initialized');

  const tools = await send('tools/list', {});
  const toolNames = (tools?.tools ?? []).map((t) => t.name).sort();
  console.log(label('Registered tools:'));
  console.log('  ' + toolNames.join('\n  '));

  const missing = ['dkg_propose_decision', 'dkg_add_task', 'dkg_comment', 'dkg_request_vm_publish', 'dkg_set_session_privacy']
    .filter((t) => !toolNames.includes(t));
  if (missing.length) {
    console.error(`\n✘ write tools missing from registration: ${missing.join(', ')}`);
    child.kill();
    process.exit(1);
  }

  const stamp = Date.now();

  await callTool('dkg_propose_decision', {
    title: `Smoke · adopt tree-sitter for Python parsing (${stamp})`,
    context: 'We need incremental AST reparsing for live editor integration.',
    outcome: 'Adopt tree-sitter-python behind a Parser interface.',
    consequences: 'Adds ~1.5MB to bundle; simpler reparse on edits; DSL learning curve.',
    status: 'proposed',
  });

  const taskRes = await callTool('dkg_add_task', {
    title: `Smoke · stub Parser interface (${stamp})`,
    priority: 'p1',
    status: 'todo',
    estimate: 2,
    assignee: 'branarakic',
  });
  const taskUri = taskRes?.content?.[0]?.text?.match(/URI\*\*: `([^`]+)`/)?.[1];

  if (taskUri) {
    await callTool('dkg_comment', {
      entityUri: taskUri,
      body: 'Smoke comment — make sure to write a contract test alongside.',
    });
    await callTool('dkg_request_vm_publish', {
      entityUri: taskUri,
      rationale: 'Smoke VM-publish request — would only matter if this task became a commitment. Testing the marker write path.',
    });
  }

  await callTool('dkg_set_session_privacy', {
    sessionUri: `urn:dkg:chat:session:smoke-${stamp}`,
    privacy: 'private',
  });

  console.log('\n' + label('✔ smoke done'));
} catch (err) {
  console.error(`\n✘ smoke failed: ${err?.stack ?? err?.message ?? err}`);
  child.kill();
  process.exit(1);
}

child.kill();
await once(child, 'close');
