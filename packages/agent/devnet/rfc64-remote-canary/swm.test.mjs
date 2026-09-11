// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCanaryError,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import {
  verifyLiveSwmPropagationV1,
  verifyOfflineCatchupV1,
} from './swm.mjs';
import { baseConfig, CG, statusBody } from './test-support.mjs';

test('one transient failed probe cannot certify a no-op receiver stop', async () => {
  const commands = [];
  let probes = 0;
  await assert.rejects(
    verifyOfflineCatchupV1({
      config: {
        contextGraphs: [],
        timing: { pollIntervalMs: 1 },
      },
      lifecycle: {
        receiver: { id: 'receiver' },
        stop: { argv: ['control', 'stop'] },
        start: { argv: ['control', 'start'] },
        commandTimeoutMs: 1_000,
        stopTimeoutMs: 25,
      },
      request: {
        reachable: async () => {
          probes += 1;
          return probes !== 1;
        },
      },
      runCommand: async (command) => {
        commands.push(command.argv[1]);
        return { code: 0, signal: null, stdout: '' };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'receiver-did-not-stop',
  );
  assert.ok(probes >= 2);
  assert.deepEqual(commands, ['stop', 'start']);
});

test('receiver must remain unreachable throughout offline marker sharing', async () => {
  const commands = [];
  const source = { id: 'source' };
  const receiver = { id: 'receiver' };
  let probes = 0;
  await assert.rejects(
    verifyOfflineCatchupV1({
      config: {
        contextGraphs: [{ id: CG, source, receiver }],
        timing: { pollIntervalMs: 1 },
      },
      lifecycle: {
        receiver,
        stop: { argv: ['control', 'stop'] },
        start: { argv: ['control', 'start'] },
        commandTimeoutMs: 1_000,
        stopTimeoutMs: 100,
      },
      request: {
        reachable: async () => {
          probes += 1;
          return probes > 3;
        },
      },
      runCommand: async (command) => {
        commands.push(command.argv[1]);
        return { code: 0, signal: null, stdout: '' };
      },
      sleep: async () => undefined,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'receiver-became-reachable-during-offline-window',
  );
  assert.deepEqual(commands, ['stop', 'start']);
});

test('live SWM propagation fails when sharing succeeds but delivery never arrives', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  await assert.rejects(
    verifyLiveSwmPropagationV1({
      config: {
        ...config,
        timing: { ...config.timing, propagationTimeoutMs: 20, pollIntervalMs: 1 },
      },
      request: {
        json: async (node, method, path) => (
          path === '/api/knowledge-assets'
            ? { swmShared: true }
            : { result: { type: 'boolean', value: false } }
        ),
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'swm-propagation-timeout',
  );
});

test('offline catch-up fails when a restarted receiver never receives the marker', async () => {
  const validated = validateRemoteCanaryConfigV1(baseConfig());
  const config = {
    ...validated,
    timing: { ...validated.timing, catchupTimeoutMs: 20, pollIntervalMs: 1 },
  };
  const lifecycle = { ...validated.lifecycle, stopTimeoutMs: 100, readyTimeoutMs: 100 };
  const commands = [];
  let receiverOnline = true;
  await assert.rejects(
    verifyOfflineCatchupV1({
      config,
      lifecycle,
      request: {
        reachable: async () => receiverOnline,
        json: async (node, method, path) => {
          if (path === '/api/knowledge-assets') return { swmShared: true };
          if (path === '/api/status') return statusBody();
          return { result: { type: 'boolean', value: false } };
        },
      },
      runCommand: async (command) => {
        commands.push(command.argv[1]);
        receiverOnline = command.argv[1] !== 'stop';
        return { code: 0, signal: null, stdout: '' };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'offline-catchup-timeout',
  );
  assert.deepEqual(commands, ['stop', 'start']);
  assert.equal(receiverOnline, true);
});
