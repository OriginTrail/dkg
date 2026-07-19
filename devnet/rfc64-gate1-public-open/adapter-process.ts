import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import {
  atomicWriteStableJson,
  stableJson,
} from '../rfc64-persistence-lifecycle/evidence.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_FIXTURE,
  GATE1_FIXTURE_ADAPTER_ID,
  assertFixtureDerivations,
  expectedAppliedReadBack,
  type Gate1TransferFixture,
} from './model.js';

const EVENT_PREFIX = 'RFC64_GATE1_ADAPTER_EVENT ';
const role = process.argv[2];
const dataDirInput = process.env.DKG_RFC64_GATE1_ADAPTER_DATA_DIR;
if (role !== 'author' && role !== 'receiver') throw new Error('adapter role is required');
if (!dataDirInput) throw new Error('DKG_RFC64_GATE1_ADAPTER_DATA_DIR is required');
const dataDir = resolve(dataDirInput);
const semanticPath = join(dataDir, 'semantic-state.json');
const appliedPath = join(dataDir, 'applied-head.json');
const repairIntentPath = join(dataDir, 'repair-intent.json');

interface Command {
  readonly command: string;
  readonly requestId: string;
  readonly fixture?: unknown;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ role, ...event })}\n`);
}

async function emitAndFlush(event: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(
      `${EVENT_PREFIX}${JSON.stringify({ role, ...event })}\n`,
      (error) => error === null || error === undefined ? resolveWrite() : rejectWrite(error),
    );
  });
}

function exactFixture(input: unknown, expected: Gate1TransferFixture, label: string): void {
  if (stableJson(input) !== stableJson(expected)) {
    throw new Error(`${label} differs from the adapter-pinned exact fixture`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeState(path: string, value: unknown): void {
  atomicWriteStableJson(path, value);
}

async function repairAtStartup(): Promise<Record<string, unknown> | null> {
  if (role !== 'receiver') return null;
  let intent: unknown;
  try {
    intent = readJson(repairIntentPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  const expectedIntent = {
    durable: true,
    target: expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
  };
  if (stableJson(intent) !== stableJson(expectedIntent)) {
    throw new Error('restart repair intent differs from the pinned successor');
  }
  const semantic = readJson(semanticPath);
  const expectedSemantic = semanticState(GATE1_FIXTURE.repairSuccessor);
  if (stableJson(semantic) !== stableJson(expectedSemantic)) {
    throw new Error('restart repair semantic state differs from the durable intent');
  }
  const before = readJson(appliedPath);
  const expectedBefore = expectedAppliedReadBack(GATE1_FIXTURE.positive);
  if (stableJson(before) !== stableJson(expectedBefore)) {
    throw new Error('restart repair predecessor applied head is not exact');
  }
  const after = expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor);
  writeState(appliedPath, after);
  await rm(repairIntentPath, { force: true });
  return {
    action: 'advanced-applied-head-from-durable-intent',
    after: readJson(appliedPath),
    before,
    repaired: true,
    semanticPostRead: semantic,
  };
}

function semanticState(fixture: Gate1TransferFixture): Readonly<Record<string, unknown>> {
  return Object.freeze({
    activatedQuadCount: fixture.activatedQuadCount,
    catalogHeadDigest: fixture.head.catalogHeadDigest,
    catalogRowDigest: fixture.catalogRowDigest,
    contentDigest: fixture.contentDigest,
    kaUal: fixture.kaUal,
    swmGraph: fixture.swmGraph,
  });
}

async function handle(command: Command): Promise<void> {
  const { requestId } = command;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('requestId is required');
  }
  switch (command.command) {
    case 'serve-positive':
      requireRole('author');
      emit({ event: 'positive-served', fixture: GATE1_FIXTURE.positive, requestId });
      return;
    case 'serve-repair-successor':
      requireRole('author');
      emit({ event: 'repair-successor-served', fixture: GATE1_FIXTURE.repairSuccessor, requestId });
      return;
    case 'serve-forged':
      requireRole('author');
      emit({ event: 'forged-served', fixture: GATE1_FIXTURE.forged, requestId });
      return;
    case 'attempt-forged': {
      requireRole('receiver');
      if (stableJson(command.fixture) !== stableJson(GATE1_FIXTURE.forged)) {
        throw new Error('forged attempt differs from the adapter-pinned fixture');
      }
      emit({
        activationAfter: 0,
        activationBefore: 0,
        appliedHeadAfter: null,
        appliedHeadBefore: null,
        attemptedCatalogHeadDigest: GATE1_FIXTURE.forged.attemptedCatalogHeadDigest,
        event: 'forged-author-rejected',
        failureCode: GATE1_FIXTURE.forged.expectedFailureCode,
        recoveredAuthorAddress: GATE1_FIXTURE.forged.recoveredAuthorAddress,
        requestId,
      });
      return;
    }
    case 'activate-positive': {
      requireRole('receiver');
      exactFixture(command.fixture, GATE1_FIXTURE.positive, 'positive transfer');
      const semantic = semanticState(GATE1_FIXTURE.positive);
      const applied = expectedAppliedReadBack(GATE1_FIXTURE.positive);
      writeState(semanticPath, semantic);
      writeState(appliedPath, applied);
      emit({
        appliedReadBack: readJson(appliedPath),
        controlObjectsVerified: 3,
        event: 'positive-activated',
        exact: GATE1_FIXTURE.positive,
        requestId,
        semanticPostRead: readJson(semanticPath),
      });
      return;
    }
    case 'prepare-repair-crash': {
      requireRole('receiver');
      exactFixture(command.fixture, GATE1_FIXTURE.repairSuccessor, 'repair successor');
      const before = readJson(appliedPath);
      const expectedBefore = expectedAppliedReadBack(GATE1_FIXTURE.positive);
      if (stableJson(before) !== stableJson(expectedBefore)) {
        throw new Error('repair predecessor does not equal the positive durable applied head');
      }
      writeState(semanticPath, semanticState(GATE1_FIXTURE.repairSuccessor));
      writeState(repairIntentPath, {
        durable: true,
        target: expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
      });
      emit({
        appliedBeforeCrash: before,
        event: 'repair-gap-durable',
        repairIntentDurable: true,
        requestId,
        semanticBeforeCrash: readJson(semanticPath),
        target: expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
      });
      return;
    }
    case 'read-repaired': {
      requireRole('receiver');
      emit({
        appliedReadBack: readJson(appliedPath),
        event: 'repair-read-back',
        requestId,
        semanticPostRead: readJson(semanticPath),
      });
      return;
    }
    case 'stop':
      await emitAndFlush({ event: 'stopped', requestId });
      process.exit(0);
    default:
      throw new Error(`unknown adapter command: ${command.command}`);
  }
}

function requireRole(expected: 'author' | 'receiver'): void {
  if (role !== expected) throw new Error(`${role} cannot handle ${expected} command`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

assertFixtureDerivations();
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const startupRepair = await repairAtStartup();
emit({
  adapterId: GATE1_FIXTURE_ADAPTER_ID,
  event: 'ready',
  peerId: role === 'author' ? GATE1_FIXTURE.authorPeerId : GATE1_FIXTURE.receiverPeerId,
  protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
  startupRepair,
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let command: Command;
  try {
    command = JSON.parse(line) as Command;
  } catch (error) {
    emit({ event: 'error', message: `invalid command JSON: ${String(error)}` });
    return;
  }
  void handle(command).catch((error) => {
    emit({
      event: 'error',
      message: error instanceof Error ? error.message : String(error),
      requestId: command.requestId,
    });
  });
});
