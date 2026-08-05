import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { ChildProcessRegistry } from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate1AgentChild } from './agent-child.js';
import { GATE1_AGENT_EVENT_PREFIX } from './model.js';

const CWD = process.cwd();

function child(script: string, registry = new ChildProcessRegistry(5_000)): Gate1AgentChild {
  return new Gate1AgentChild({
    eventTimeoutMs: 2_000,
    registry,
    role: 'receiver',
    spawn: {
      args: ['--input-type=module', '--eval', script],
      command: process.execPath,
      cwd: CWD,
      env: { ...process.env },
    },
  });
}

const lineProtocolPrelude = `
  import { createInterface } from 'node:readline';
  const prefix = ${JSON.stringify(GATE1_AGENT_EVENT_PREFIX)};
  const emit = (value) => process.stdout.write(prefix + JSON.stringify({ role: 'receiver', ...value }) + '\\n');
  emit({ event: 'ready', peerId: 'real-peer' });
  const lines = createInterface({ input: process.stdin });
`;

test('request correlation and graceful stop use exact process events', async () => {
  const proc = child(`${lineProtocolPrelude}
    lines.on('line', (line) => {
      const command = JSON.parse(line);
      if (command.command === 'probe') emit({ event: 'probed', requestId: command.requestId });
      if (command.command === 'stop') {
        emit({ event: 'stopped', requestId: command.requestId });
        process.exit(0);
      }
    });
  `);
  assert.equal((await proc.waitFor('ready')).peerId, 'real-peer');
  assert.equal((await proc.request('probe', 'probe-1', 'probed')).requestId, 'probe-1');
  assert.deepEqual(await proc.stop('stop-1'), { code: 0, signal: null });
});

test('killRestart waits for the child boundary and proves an actual SIGKILL close', async () => {
  const proc = child(`${lineProtocolPrelude}
    lines.on('line', (line) => {
      const command = JSON.parse(line);
      if (command.command === 'killRestart') {
        emit({ event: 'kill-restart-ready', requestId: command.requestId });
      }
    });
  `);
  await proc.waitFor('ready');
  assert.deepEqual(await proc.killRestartBoundary('kill-1'), { code: null, signal: 'SIGKILL' });
});

test('a process close rejects an outstanding request with captured diagnostics', async () => {
  const proc = child(`${lineProtocolPrelude}
    process.stderr.write('diagnostic-before-close\\n');
    lines.on('line', () => process.exit(23));
  `);
  await proc.waitFor('ready');
  await assert.rejects(
    proc.request('never', 'never-1', 'never-completes'),
    /closed before its expected event[\s\S]*diagnostic-before-close/,
  );
});

test('adapter error events reject the correlated request without waiting for timeout', async () => {
  const registry = new ChildProcessRegistry(5_000);
  const proc = child(`${lineProtocolPrelude}
    lines.on('line', (line) => {
      const command = JSON.parse(line);
      emit({ event: 'error', requestId: command.requestId, message: 'missing product method' });
    });
  `, registry);
  await proc.waitFor('ready');
  await assert.rejects(
    proc.request('publishSuccessor', 'successor-1', 'operation-completed'),
    /missing product method/,
  );
  await registry.terminateAndWait(proc.tracked, 'SIGKILL');
});
