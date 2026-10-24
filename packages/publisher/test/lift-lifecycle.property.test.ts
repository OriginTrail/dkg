import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

const options = propertyOptions();
// Keep the original campaign bound. A per-example deadline separately detects
// a stuck operation; interruption is a failure, never a truncated pass.
const campaignTimeoutMs = 30_000;
const identity = 'generated claim, validate, finalize and restart sequences preserve durable lifecycle state';

it(identity, async () => {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let completedExecutions = 0;
  let slowestExecutionMs = 0;
  function record(status: string, details: Record<string, unknown> = {}) {
    const receipt = {
      schemaVersion: 1, identity, status, startedAt, recordedAt: new Date().toISOString(),
      durationMs: performance.now() - started, node: process.version, platform: process.platform,
      fastCheck: fc.__version, subject: process.env.DKG_CI_SUBJECT ?? process.env.GITHUB_SHA ?? null,
      profile: process.env.DKG_CI_PROFILE ?? 'local', repository: process.env.GITHUB_REPOSITORY ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null, runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT, seed: options.seed, requestedTrials: options.numRuns,
      completedTrials: null, completedExecutions, slowestExecutionMs, timeoutMs: campaignTimeoutMs,
      ...details,
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/lift-lifecycle-campaign.json.tmp', JSON.stringify(receipt, null, 2) + '\n');
    renameSync('test-results/lift-lifecycle-campaign.json.tmp', 'test-results/lift-lifecycle-campaign.json');
  }
  record('running');
  const result = await fc.check(fc.asyncProperty(fc.array(fc.constantFrom('claim', 'validate', 'finalize', 'restart'), { maxLength: 25 }), async (commands) => {
    const executionStarted = performance.now();
    const store = new OxigraphStore();
    try {
      let now = 1_000;
      const config = { now: () => ++now, idGenerator: () => 'generated-job', journalWrites: true };
      let publisher = new TripleStoreAsyncLiftPublisher(store, config);
      const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      let state = 'accepted';
      const request = (await publisher.getStatus(id))!.request;
      for (const command of commands) {
        if (command === 'restart') publisher = new TripleStoreAsyncLiftPublisher(store, config);
        else if (command === 'claim') {
          const claimed = await publisher.claimNext('wallet-1');
          expect(claimed?.jobId ?? null).toBe(state === 'accepted' ? id : null);
          if (state === 'accepted') state = 'claimed';
        } else {
          const next = command === 'validate' ? 'validated' : 'finalized';
          // Administrative updates allow an idempotent replay of the same state.
          const legal = state === next || (state === 'claimed' && next === 'validated') || (state === 'validated' && next === 'finalized');
          const operation = next === 'validated'
            ? publisher.update(id, 'validated', { validation: KA_VM_VALIDATION })
            : publisher.update(id, 'finalized', { finalization: { mode: 'local' } });
          if (legal) { await operation; state = next; }
          else await expect(operation).rejects.toThrow();
        }
        const persisted = await publisher.getStatus(id);
        expect(persisted?.status).toBe(state);
        expect(persisted?.request).toEqual(request);
        expect(persisted?.jobId).toBe(id);
      }
    } finally {
      await store.close();
    }
    completedExecutions++;
    slowestExecutionMs = Math.max(slowestExecutionMs, performance.now() - executionStarted);
    if (completedExecutions % 25 === 0) record('running');
    // Allow cancellation and deadline timers to run between independent trials.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }), { ...options, timeout: 5_000, interruptAfterTimeLimit: campaignTimeoutMs - 5_000, markInterruptAsFailure: true });
  record(result.failed ? 'failed' : 'passed', {
    completedTrials: result.failed ? null : result.numRuns,
    numRuns: result.numRuns, numSkips: result.numSkips, interrupted: result.interrupted,
    counterexamplePath: result.counterexamplePath, counterexample: result.counterexample,
    failure: result.failed ? fc.defaultReportMessage(result) : null,
    failureReason: result.errorInstance instanceof Error ? result.errorInstance.message : null,
  });
  console.log(`Lift lifecycle: seed=${options.seed}, requested=${options.numRuns}, runs=${result.numRuns}, interrupted=${result.interrupted}, durationMs=${Math.round(performance.now() - started)}`);
  if (result.failed) throw new Error(fc.defaultReportMessage(result), { cause: result.errorInstance });
}, campaignTimeoutMs);
