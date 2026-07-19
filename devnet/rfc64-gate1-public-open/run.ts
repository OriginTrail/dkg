import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
  stableJson,
} from '../rfc64-persistence-lifecycle/evidence.js';
import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
  type ProcessExitEvidence,
  type TrackedChildProcess,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_FIXTURE,
  GATE1_FIXTURE_ADAPTER_ID,
  GATE1_RAW_SCHEMA_VERSION,
  INSPECTED_PRODUCT_COMMITS,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  assertFixtureDerivations,
  expectedAppliedReadBack,
  type Gate1TransferFixture,
} from './model.js';

const EVENT_PREFIX = 'RFC64_GATE1_ADAPTER_EVENT ';
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const DEFAULT_ARTIFACT = join(import.meta.dirname, 'artifacts/gate1-result.json');
const PROCESS_TIMEOUT_MS = 30_000;
const children = new ChildProcessRegistry(15_000);

interface AdapterEvent {
  readonly event: string;
  readonly requestId?: string;
  readonly role: 'author' | 'receiver';
  readonly [key: string]: unknown;
}

interface PendingEvent {
  readonly expectedEvent: string;
  readonly reject: (error: Error) => void;
  readonly requestId: string | null;
  readonly resolve: (event: AdapterEvent) => void;
  readonly timer: NodeJS.Timeout;
}

class AdapterChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tracked: TrackedChildProcess;
  readonly #events: AdapterEvent[] = [];
  readonly #pending = new Set<PendingEvent>();
  #stderr = '';
  #stdout = '';
  #lineBuffer = '';

  constructor(
    readonly role: 'author' | 'receiver',
    dataDir: string,
  ) {
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx', ADAPTER_PROCESS, role],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DKG_RFC64_GATE1_ADAPTER_DATA_DIR: dataDir,
          NODE_ENV: 'production',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.tracked = children.track(this.child);
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => { this.#stderr += chunk; });
    this.child.once('error', (error) => this.rejectAll(error));
    void this.tracked.closed.then((exit) => {
      if (this.#pending.size === 0) return;
      this.rejectAll(new Error(
        `${this.role} adapter closed before its expected event: ${JSON.stringify(exit)}\n`
          + `stdout:\n${this.#stdout}\nstderr:\n${this.#stderr}`,
      ));
    });
  }

  waitFor(expectedEvent: string, requestId: string | null = null): Promise<AdapterEvent> {
    const existing = this.#events.find((event) =>
      event.event === expectedEvent && (requestId === null || event.requestId === requestId));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<AdapterEvent>((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.#pending.delete(pending);
        rejectEvent(new Error(
          `${this.role} adapter timed out waiting for ${expectedEvent}/${requestId ?? '*'}\n`
            + `stdout:\n${this.#stdout}\nstderr:\n${this.#stderr}`,
        ));
      }, PROCESS_TIMEOUT_MS);
      const pending: PendingEvent = {
        expectedEvent,
        reject: rejectEvent,
        requestId,
        resolve: resolveEvent,
        timer,
      };
      this.#pending.add(pending);
    });
  }

  async request(
    command: string,
    requestId: string,
    expectedEvent: string,
    fixture?: unknown,
  ): Promise<AdapterEvent> {
    const event = this.waitFor(expectedEvent, requestId);
    const payload = fixture === undefined
      ? { command, requestId }
      : { command, fixture, requestId };
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error === null || error === undefined) resolveWrite();
        else rejectWrite(error);
      });
    });
    return event;
  }

  async stop(requestId: string): Promise<ProcessExitEvidence> {
    const stopped = this.request('stop', requestId, 'stopped');
    await stopped;
    const exit = await this.tracked.closed;
    requireCondition(exit.code === 0 && exit.signal === null, `${this.role} did not stop cleanly`);
    return exit;
  }

  private consumeStdout(chunk: string): void {
    this.#stdout += chunk;
    this.#lineBuffer += chunk;
    const lines = this.#lineBuffer.split('\n');
    this.#lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith(EVENT_PREFIX)) continue;
      let event: AdapterEvent;
      try {
        event = JSON.parse(line.slice(EVENT_PREFIX.length)) as AdapterEvent;
      } catch (error) {
        this.rejectAll(new Error(`invalid adapter event JSON: ${String(error)}`));
        continue;
      }
      this.#events.push(event);
      for (const pending of this.#pending) {
        if (
          event.event !== pending.expectedEvent
          || (pending.requestId !== null && event.requestId !== pending.requestId)
        ) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(pending);
        pending.resolve(event);
      }
      if (event.event === 'error') {
        this.rejectAll(new Error(
          `${this.role} adapter error for ${event.requestId ?? 'unknown request'}: `
            + `${String(event.message)}`,
        ));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function exactEventValue(event: AdapterEvent, key: string, expected: unknown): unknown {
  const actual = event[key];
  requireCondition(
    stableJson(actual) === stableJson(expected),
    `${event.role}/${event.event}.${key} differed from the pinned evidence contract`,
  );
  return actual;
}

function selectReady(event: AdapterEvent): Record<string, unknown> {
  return {
    adapterId: event.adapterId,
    peerId: event.peerId,
    protocolVersion: event.protocolVersion,
    role: event.role,
    startupRepair: event.startupRepair,
  };
}

async function execute(): Promise<void> {
  assertFixtureDerivations();
  const headBefore = readCleanRepositoryHead(REPO_ROOT);
  const authorDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate1-author-'));
  const receiverDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate1-receiver-'));
  let operationFailed = true;
  let primaryFailure: unknown;
  try {
    const author = new AdapterChild('author', authorDataDir);
    const receiver = new AdapterChild('receiver', receiverDataDir);
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    requireReady(authorReady, GATE1_FIXTURE.authorPeerId, null);
    requireReady(receiverReady, GATE1_FIXTURE.receiverPeerId, null);
    requireCondition(authorReady.peerId !== receiverReady.peerId, 'peer identities are not distinct');

    const forgedServed = await author.request(
      'serve-forged',
      'forged-served-v1',
      'forged-served',
    );
    const forgedFixture = exactEventValue(forgedServed, 'fixture', GATE1_FIXTURE.forged);
    const forgedRejected = await receiver.request(
      'attempt-forged',
      'forged-rejected-v1',
      'forged-author-rejected',
      forgedFixture,
    );

    const positiveServed = await author.request(
      'serve-positive',
      'positive-served-v1',
      'positive-served',
    );
    const positiveFixture = exactEventValue(positiveServed, 'fixture', GATE1_FIXTURE.positive);
    const positiveActivated = await receiver.request(
      'activate-positive',
      'positive-activated-v1',
      'positive-activated',
      positiveFixture,
    );

    const repairServed = await author.request(
      'serve-repair-successor',
      'repair-served-v1',
      'repair-successor-served',
    );
    const repairFixture = exactEventValue(
      repairServed,
      'fixture',
      GATE1_FIXTURE.repairSuccessor,
    );
    const repairGap = await receiver.request(
      'prepare-repair-crash',
      'repair-gap-v1',
      'repair-gap-durable',
      repairFixture,
    );
    const receiverCrashExit = await children.terminateAndWait(receiver.tracked, 'SIGKILL');
    requireCondition(
      receiverCrashExit.code === null && receiverCrashExit.signal === 'SIGKILL',
      'receiver crash boundary was not SIGKILL',
    );

    const restartedReceiver = new AdapterChild('receiver', receiverDataDir);
    const restartedReady = await restartedReceiver.waitFor('ready');
    const expectedRepair = {
      action: 'advanced-applied-head-from-durable-intent',
      after: expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
      before: expectedAppliedReadBack(GATE1_FIXTURE.positive),
      repaired: true,
      semanticPostRead: semanticEvidence(GATE1_FIXTURE.repairSuccessor),
    };
    requireReady(restartedReady, GATE1_FIXTURE.receiverPeerId, expectedRepair);
    const repairReadBack = await restartedReceiver.request(
      'read-repaired',
      'repair-read-back-v1',
      'repair-read-back',
    );

    const restartedReceiverExit = await restartedReceiver.stop('receiver-stop-v1');
    const authorExit = await author.stop('author-stop-v1');
    const headAfter = readCleanRepositoryHead(REPO_ROOT);
    requireCondition(headAfter === headBefore, 'tracked source commit changed during Gate 1 run');

    const artifact = {
      adapter: {
        id: GATE1_FIXTURE_ADAPTER_ID,
        inspectedProductCommits: INSPECTED_PRODUCT_COMMITS,
        productBoundary: 'not-connected',
        protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
        requiredProductionOperations: REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
        replacementContract:
          'replace adapter-process commands with production DKGAgent operations without changing evidence schema',
      },
      fixture: {
        forged: GATE1_FIXTURE.forged,
        positive: GATE1_FIXTURE.positive,
        repairSuccessor: GATE1_FIXTURE.repairSuccessor,
      },
      gate: 'OT-RFC-64 Gate 1 harness contract',
      gateEvaluation: {
        reason:
          'deterministic adapter proves orchestration and fail-closed evidence verification, not production Gate 1',
        status: 'not-evaluated',
      },
      harnessChecksPassed: true,
      invocation: 'pnpm test:gate1:rfc64-public-open-harness',
      phases: {
        forgedAuthor: {
          activationAfter: forgedRejected.activationAfter,
          activationBefore: forgedRejected.activationBefore,
          appliedHeadAfter: forgedRejected.appliedHeadAfter,
          appliedHeadBefore: forgedRejected.appliedHeadBefore,
          attemptedCatalogHeadDigest: forgedRejected.attemptedCatalogHeadDigest,
          failureCode: forgedRejected.failureCode,
          recoveredAuthorAddress: forgedRejected.recoveredAuthorAddress,
          servedByPeerId: authorReady.peerId,
          testedByPeerId: receiverReady.peerId,
        },
        positiveSync: {
          appliedReadBack: positiveActivated.appliedReadBack,
          controlObjectsVerified: positiveActivated.controlObjectsVerified,
          exact: positiveActivated.exact,
          receivedByPeerId: receiverReady.peerId,
          semanticPostRead: positiveActivated.semanticPostRead,
          servedByPeerId: authorReady.peerId,
        },
        restartRepair: {
          crashExit: receiverCrashExit,
          gap: {
            appliedBeforeCrash: repairGap.appliedBeforeCrash,
            repairIntentDurable: repairGap.repairIntentDurable,
            semanticBeforeCrash: repairGap.semanticBeforeCrash,
            target: repairGap.target,
          },
          readBack: {
            appliedReadBack: repairReadBack.appliedReadBack,
            semanticPostRead: repairReadBack.semanticPostRead,
          },
          restartedReady: selectReady(restartedReady),
          successorServedByPeerId: authorReady.peerId,
        },
      },
      processBoundary: {
        authorInstances: 1,
        model: 'two concurrent adapter peer processes plus one receiver restart',
        receiverInstances: 2,
        stoppedExits: {
          author: authorExit,
          restartedReceiver: restartedReceiverExit,
        },
      },
      ready: {
        author: selectReady(authorReady),
        receiver: selectReady(receiverReady),
      },
      repository: {
        testedHeadCommit: headBefore,
        trackedSourceCleanAfterProcesses: true,
        trackedSourceCleanBeforeSpawn: true,
      },
      schemaVersion: GATE1_RAW_SCHEMA_VERSION,
    };

    const artifactPath = process.env.DKG_RFC64_GATE1_ARTIFACT ?? DEFAULT_ARTIFACT;
    const publication = atomicWriteStableJson(artifactPath, artifact);
    process.stdout.write(
      `[rfc64-gate1-harness] wrote ${artifactPath} sha256=${publication.sha256}\n`,
    );
    operationFailed = false;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => children.terminateAllThenCleanup(() => {
        rmSync(authorDataDir, { force: true, recursive: true });
        rmSync(receiverDataDir, { force: true, recursive: true });
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-gate1-harness] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
        );
      },
    });
  }
}

function semanticEvidence(fixture: Gate1TransferFixture): Record<string, unknown> {
  return {
    activatedQuadCount: fixture.activatedQuadCount,
    catalogHeadDigest: fixture.head.catalogHeadDigest,
    catalogRowDigest: fixture.catalogRowDigest,
    contentDigest: fixture.contentDigest,
    kaUal: fixture.kaUal,
    swmGraph: fixture.swmGraph,
  };
}

function requireReady(event: AdapterEvent, peerId: string, startupRepair: unknown): void {
  requireCondition(event.role === (peerId === GATE1_FIXTURE.authorPeerId ? 'author' : 'receiver'),
    'ready role differs from peer identity');
  requireCondition(event.adapterId === GATE1_FIXTURE_ADAPTER_ID, 'adapter ID changed');
  requireCondition(event.protocolVersion === GATE1_ADAPTER_PROTOCOL_VERSION, 'protocol changed');
  requireCondition(event.peerId === peerId, 'peer ID changed');
  requireCondition(
    stableJson(event.startupRepair) === stableJson(startupRepair),
    'startup repair evidence changed',
  );
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await execute();
