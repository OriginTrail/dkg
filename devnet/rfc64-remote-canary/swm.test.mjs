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
  withReceiverOfflineV1,
} from './swm.mjs';
import {
  SECOND_CG,
  baseConfig,
  CG,
  statusBody,
} from './test-support.mjs';

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
  let receiverOnline = true;
  let shares = 0;
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
        reachable: async () => receiverOnline,
        json: async (_node, _method, path) => {
          assert.equal(path, '/api/knowledge-assets');
          shares += 1;
          receiverOnline = true;
          return { swmShared: true };
        },
      },
      runCommand: async (command) => {
        commands.push(command.argv[1]);
        receiverOnline = command.argv[1] !== 'stop';
        return { code: 0, signal: null, stdout: '' };
      },
      sleep: async () => undefined,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'receiver-became-reachable-during-offline-window',
  );
  assert.deepEqual(commands, ['stop', 'start']);
  assert.equal(shares, 1);
});

test('receiver reachability before marker sharing prevents any offline publish', async () => {
  const commands = [];
  const source = { id: 'source' };
  const receiver = { id: 'receiver' };
  let receiverOnline = true;
  let offlineChecks = 0;
  let shares = 0;
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
          if (!receiverOnline) {
            offlineChecks += 1;
            if (offlineChecks > 3) receiverOnline = true;
          }
          return receiverOnline;
        },
        json: async () => {
          shares += 1;
          return { swmShared: true };
        },
      },
      runCommand: async (command) => {
        commands.push(command.argv[1]);
        receiverOnline = command.argv[1] !== 'stop';
        return { code: 0, signal: null, stdout: '' };
      },
      sleep: async () => undefined,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'receiver-became-reachable-during-offline-window',
  );
  assert.deepEqual(commands, ['stop', 'start']);
  assert.equal(shares, 0);
});

test('live SWM propagation fails when sharing succeeds but delivery never arrives', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const markerQueryNodes = [];
  await assert.rejects(
    verifyLiveSwmPropagationV1({
      config: {
        ...config,
        timing: { ...config.timing, propagationTimeoutMs: 20, pollIntervalMs: 1 },
      },
      request: {
        json: async (node, method, path) => {
          if (path === '/api/knowledge-assets') return { swmShared: true };
          markerQueryNodes.push(node.role);
          return { result: { type: 'boolean', value: node.role === 'source' } };
        },
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'swm-propagation-timeout',
  );
  assert.ok(markerQueryNodes.length > 0);
  assert.equal(markerQueryNodes.every((role) => role === 'receiver'), true);
});

test('offline catch-up fails when a restarted receiver never receives the marker', async () => {
  const validated = validateRemoteCanaryConfigV1(baseConfig());
  const config = {
    ...validated,
    timing: { ...validated.timing, catchupTimeoutMs: 20, pollIntervalMs: 1 },
  };
  const lifecycle = { ...validated.lifecycle, stopTimeoutMs: 100, readyTimeoutMs: 100 };
  const commands = [];
  const markerQueryNodes = [];
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
          markerQueryNodes.push(node.role);
          return { result: { type: 'boolean', value: node.role === 'source' } };
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
  assert.ok(markerQueryNodes.length > 0);
  assert.equal(markerQueryNodes.every((role) => role === 'receiver'), true);
});

test('receiver lifecycle bracket attempts exactly one recovery across failure paths', async () => {
  for (const scenario of [
    { label: 'stop', stopCode: 1, operationFails: false, startCode: 0, expected: 'receiver-stop-command-failed' },
    { label: 'stop-rejection', stopRejects: true, stopCode: 0, operationFails: false, startCode: 0, expected: 'command-timeout' },
    { label: 'callback', stopCode: 0, operationFails: true, startCode: 0, expected: 'offline-operation-failed' },
    { label: 'start', stopCode: 0, operationFails: false, startCode: 1, expected: 'receiver-start-command-failed' },
    { label: 'start-rejection', startRejects: true, stopCode: 0, operationFails: false, startCode: 0, expected: 'receiver-start-command-failed', startCause: 'command-output-limit' },
    { label: 'callback-and-start', stopCode: 0, operationFails: true, startCode: 1, expected: 'receiver-start-command-failed', combined: true },
  ]) {
    const commands = [];
    let operationCalls = 0;
    await assert.rejects(
      withReceiverOfflineV1({
        config: { timing: { pollIntervalMs: 1 } },
        lifecycle: {
          receiver: { id: 'receiver' },
          stop: { argv: ['control', 'stop'] },
          start: { argv: ['control', 'start'] },
          commandTimeoutMs: 1_000,
          stopTimeoutMs: 100,
        },
        request: { reachable: async () => false },
        runCommand: async (command) => {
          const action = command.argv[1];
          commands.push(action);
          if (action === 'stop' && scenario.stopRejects) {
            throw new RemoteCanaryError('command-timeout', 'transport');
          }
          if (action === 'start' && scenario.startRejects) {
            throw new RemoteCanaryError('command-output-limit', 'transport');
          }
          return {
            code: action === 'stop' ? scenario.stopCode : scenario.startCode,
            signal: null,
            stdout: '',
          };
        },
        sleep: async () => undefined,
      }, async () => {
        operationCalls += 1;
        if (scenario.operationFails) {
          throw new RemoteCanaryError('offline-operation-failed', 'offline-catchup');
        }
      }),
      (error) => error instanceof RemoteCanaryError
        && error.code === scenario.expected
        && (!scenario.startCause || error.cause?.code === scenario.startCause)
        && (!scenario.combined || error.cause instanceof AggregateError),
      scenario.label,
    );
    assert.deepEqual(commands, ['stop', 'start'], scenario.label);
    assert.equal(
      operationCalls,
      scenario.stopRejects || scenario.stopCode !== 0 ? 0 : 1,
      scenario.label,
    );
  }
});

test('receiver lifecycle bracket confirms readiness before returning operation results', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const events = [];
  let receiverOnline = true;
  const result = await withReceiverOfflineV1({
    config,
    lifecycle: config.lifecycle,
    request: {
      reachable: async () => receiverOnline,
      json: async () => {
        events.push('ready');
        return statusBody();
      },
    },
    runCommand: async (command) => {
      const action = command.argv[1];
      events.push(action);
      receiverOnline = action !== 'stop';
      return { code: 0, signal: null, stdout: '' };
    },
    sleep: async () => undefined,
  }, async () => {
    events.push('operation');
    return 'markers';
  });
  assert.equal(result, 'markers');
  assert.deepEqual(events, ['stop', 'operation', 'start', 'ready']);
});

test('receiver recovery retries transient startup status until the daemon becomes ready', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  let receiverOnline = true;
  let statusReads = 0;
  const result = await withReceiverOfflineV1({
    config,
    lifecycle: { ...config.lifecycle, readyTimeoutMs: 100 },
    request: {
      reachable: async () => receiverOnline,
      json: async () => {
        statusReads += 1;
        const status = structuredClone(statusBody());
        if (statusReads === 1) {
          status.rfc64Certification.catalog.contextGraphs[0].phase = 'bootstrapping';
          status.rfc64Certification.catalog.contextGraphs[0].catalogServiceStarted = false;
        }
        return status;
      },
    },
    runCommand: async (command) => {
      receiverOnline = command.argv[1] !== 'stop';
      return { code: 0, signal: null, stdout: '' };
    },
    sleep: async () => undefined,
  }, async () => 'markers');

  assert.equal(result, 'markers');
  assert.equal(statusReads, 2);
});

test('receiver recovery fails immediately for a permanent build mismatch', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  let receiverOnline = true;
  let statusReads = 0;
  await assert.rejects(
    withReceiverOfflineV1({
      config,
      lifecycle: { ...config.lifecycle, readyTimeoutMs: 100 },
      request: {
        reachable: async () => receiverOnline,
        json: async () => {
          statusReads += 1;
          const status = structuredClone(statusBody());
          status.rfc64Certification.commit = 'f'.repeat(40);
          return status;
        },
      },
      runCommand: async (command) => {
        receiverOnline = command.argv[1] !== 'stop';
        return { code: 0, signal: null, stdout: '' };
      },
      sleep: async () => undefined,
    }, async () => 'markers'),
    (error) => error instanceof RemoteCanaryError && error.code === 'node-build-mismatch',
  );
  assert.equal(statusReads, 1);
});

test('offline marker failure drains in-flight shares before receiver restart', async () => {
  const rawConfig = baseConfig();
  rawConfig.contextGraphs.push({
    ...rawConfig.contextGraphs[0],
    id: SECOND_CG,
  });
  const validated = validateRemoteCanaryConfigV1(rawConfig);
  const events = [];
  let receiverOnline = true;
  let releaseDeferred;
  let announceDeferred;
  const deferredStarted = new Promise((resolve) => { announceDeferred = resolve; });
  const deferredShare = new Promise((resolve) => { releaseDeferred = resolve; });
  const run = verifyOfflineCatchupV1({
    config: validated,
    lifecycle: validated.lifecycle,
    request: {
      reachable: async () => receiverOnline,
      json: async (node, method, path, body) => {
        if (path !== '/api/knowledge-assets') throw new Error('unexpected request after failure');
        if (body.contextGraphId === CG) {
          events.push('share-one:failed');
          throw new RemoteCanaryError('offline-share-failed', 'offline-catchup');
        }
        events.push('share-two:started');
        announceDeferred();
        const result = await deferredShare;
        events.push('share-two:settled');
        return result;
      },
    },
    runCommand: async (command) => {
      const action = command.argv[1];
      events.push(action);
      receiverOnline = action !== 'stop';
      return { code: 0, signal: null, stdout: '' };
    },
    sleep: async () => undefined,
  });

  await deferredStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('stop'), true);
  assert.equal(events.includes('share-one:failed'), true);
  assert.equal(events.includes('share-two:started'), true);
  assert.equal(events.includes('start'), false);
  releaseDeferred({ swmShared: true });
  await assert.rejects(
    run,
    (error) => error instanceof RemoteCanaryError && error.code === 'offline-share-failed',
  );
  assert.ok(events.indexOf('share-two:settled') < events.indexOf('start'));
  assert.equal(events.filter((entry) => entry === 'start').length, 1);
  assert.equal(receiverOnline, true);
});
