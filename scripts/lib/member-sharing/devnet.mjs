// Access to a running devnet for the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): the nodes' API, the
// devnet's own script, its node folders and their logs. Nothing here knows
// the scenario.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const brief = answer => `HTTP ${answer.status} ${answer.text.replace(/\s+/g, ' ').slice(0, 240)}`;
export const lastLines = text => text.split('\n').slice(-3).join(' | ').slice(0, 300);

/** Polls until `check` answers { ok: true } or the time is up; returns the last answer, never asks twice for it. */
export async function waitFor(check, ms, everyMs = 1000) {
  const end = Date.now() + ms;
  let last = { ok: false, why: 'not asked' };
  for (;;) {
    last = await check();
    if (last.ok || Date.now() + everyMs > end) return last;
    await sleep(everyMs);
  }
}

function readToken(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? '';
  } catch { return ''; }
}

// A node is its number, or a node record that carries it.
const numberOf = node => (typeof node === 'object' && node !== null ? node.number : node);

/**
 * The devnet under `dir`, run by `<repoRoot>/scripts/devnet.sh`. The admin
 * token is `adminToken`, or node 1's.
 */
export function openDevnet({ repoRoot, dir, apiPortBase, libp2pPortBase, adminToken }) {
  const token = adminToken || readToken(join(dir, 'node1', 'auth.token'));
  const script = join(repoRoot, 'scripts/devnet.sh');
  const nodeDir = node => join(dir, `node${numberOf(node)}`);

  async function api(node, method, path, body, { token: bearer = token, timeoutMs = 60_000 } = {}) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPortBase + numberOf(node) - 1}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, json, text };
    } catch (error) {
      return { status: 0, json: null, text: String(error?.message ?? error) };
    }
  }

  /**
   * devnet.sh without blocking: the watches of the nodes that stay up keep
   * reading while another node stops, starts or restarts.
   */
  function devnetSh(args, env = {}, timeoutMs = 300_000) {
    return new Promise(resolve => {
      const child = spawn('bash', [script, ...args], {
        cwd: repoRoot, env: { ...process.env, DEVNET_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.on('error', error => { output += String(error?.message ?? error); });
      child.on('close', status => { clearTimeout(timer); resolve({ status, output: output.trim() }); });
    });
  }
  /** The same, for the cleanup, which must also work from a signal handler. */
  function devnetShSync(args, timeoutMs = 120_000) {
    const result = spawnSync('bash', [script, ...args], {
      cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, DEVNET_DIR: dir },
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
  }

  const nodeConfig = node => {
    try { return JSON.parse(readFileSync(join(nodeDir(node), 'config.json'), 'utf8')); } catch { return null; }
  };
  /** The numbers of the devnet's node folders. */
  const nodeNumbers = () => readdirSync(dir).map(entry => /^node(\d+)$/.exec(entry)?.[1]).filter(Boolean).map(Number);
  const multiaddrOf = node => {
    try { return readFileSync(join(nodeDir(node), 'multiaddr'), 'utf8').trim(); } catch { return ''; }
  };

  const logFile = node => join(nodeDir(node), 'daemon.log');
  const logSize = node => { try { return statSync(logFile(node)).size; } catch { return 0; } };
  function logSince(node, offset) {
    try {
      const text = readFileSync(logFile(node));
      return text.subarray(text.length >= offset ? offset : 0).toString('utf8');
    } catch { return ''; }
  }

  /**
   * Whether something listens on the port: a connection to it succeeds.
   * Synchronous, because the cleanup also runs from a signal handler.
   */
  function listening(port) {
    const probe = spawnSync(process.execPath, ['-e', `const s = require('net').connect(${Number(port)}, '127.0.0.1');
      s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 1000);`], { timeout: 5000 });
    return probe.status === 0;
  }
  const nodePorts = node => [apiPortBase + numberOf(node) - 1, libp2pPortBase + numberOf(node) - 1];

  return {
    dir, adminToken: token, api, devnetSh, devnetShSync, nodeDir, nodeConfig, nodeNumbers, multiaddrOf,
    logFile, logSize, logSince, listening, nodePorts,
  };
}
