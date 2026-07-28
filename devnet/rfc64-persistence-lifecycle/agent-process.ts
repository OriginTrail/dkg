import process from 'node:process';

import {
  computeControlObjectDigestHex,
  splitCanonicalSignedControlEnvelopeV1,
  type Digest32V1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

const EVENT_PREFIX = 'RFC64_GATE0_EVENT ';
const GRACEFUL_STOP_COMMAND = 'RFC64_GATE0_GRACEFUL_STOP_V1';
const FIXTURE_WALLET = new ethers.Wallet(`0x${'52'.repeat(32)}`);

interface CandidateSessionV1 {}

interface HarnessPersistenceV1 {
  readonly rootPath: string;
  readonly closed: boolean;
  readonly inventory: {
    createCandidateSession(): CandidateSessionV1;
  };
  readonly controlObjects: {
    readonly namespaceDurability: string;
    stageVerifiedObjects(input: readonly [{
      readonly envelope: SignedControlEnvelopeV1;
      readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
    }]): Promise<{
      readonly durable: true;
      readonly objects: readonly [{
        readonly objectDigest: Digest32V1;
        readonly signatureVariantDigest: Digest32V1;
      }];
    }>;
    getVerifiedObject(input: {
      readonly objectDigest: Digest32V1;
      readonly signatureVariantDigest: Digest32V1;
      readonly verifyIssuerSignature: typeof verifyControlEnvelopeIssuerSignatureV1;
    }): Promise<{ readonly envelope: SignedControlEnvelopeV1 } | null>;
  };
}

interface HarnessAgentInternals {
  readonly started: boolean;
  readonly rfc64PersistenceV1?: HarnessPersistenceV1;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

async function emitAndFlush(event: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(
      `${EVENT_PREFIX}${JSON.stringify(event)}\n`,
      (error) => error === null || error === undefined ? resolveWrite() : rejectWrite(error),
    );
  });
}

async function fixture(): Promise<{
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}> {
  const unsigned = {
    issuer: FIXTURE_WALLET.address.toLowerCase(),
    objectType: 'dkg-rfc64-gate0-persistence-lifecycle-v1',
    payload: {
      gate: 'gate-0',
      purpose: 'durable-control-object-restart-proof',
      sequence: '0001',
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } satisfies UnsignedControlEnvelopeV1;
  const objectDigest = computeControlObjectDigestHex(unsigned) as Digest32V1;
  const envelope = {
    ...unsigned,
    objectDigest,
    signature: await FIXTURE_WALLET.signMessage(ethers.getBytes(objectDigest)),
  } as SignedControlEnvelopeV1;
  const split = splitCanonicalSignedControlEnvelopeV1(envelope);
  return {
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
    objectDigest,
    signatureVariantDigest: split.signatureVariant.signatureVariantDigest as Digest32V1,
  };
}

const dataDir = process.env.DKG_RFC64_GATE0_DATA_DIR;
if (!dataDir) throw new Error('DKG_RFC64_GATE0_DATA_DIR is required');

const shouldStage = process.argv.includes('--stage');
const expected = await fixture();
const agent = await DKGAgent.create({
  name: 'RFC64Gate0PersistenceLifecycle',
  dataDir,
  listenHost: '127.0.0.1',
  listenPort: 0,
  bootstrapPeers: [],
  nodeRole: 'edge',
  store: new OxigraphStore(),
  syncSharedMemoryOnConnect: false,
  syncReconcilerEnabled: false,
  syncOnConnectEnabled: false,
  durableSyncEnabled: false,
  agentProfileHeartbeatMs: 0,
});

let stopping = false;
let ownedPersistence: HarnessPersistenceV1 | null = null;
async function stop(exitCode: number): Promise<never> {
  if (stopping) return await new Promise<never>(() => undefined);
  stopping = true;
  try {
    await agent.stop();
    if (ownedPersistence?.closed !== true) {
      throw new Error('DKGAgent.stop() returned without closing RFC-64 persistence');
    }
    await emitAndFlush({
      event: 'stopped',
      graceful: true,
      persistenceClosed: true,
    });
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

let commandBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  commandBuffer += chunk;
  const commands = commandBuffer.split('\n');
  commandBuffer = commands.pop() ?? '';
  for (const command of commands) {
    if (command !== GRACEFUL_STOP_COMMAND) {
      process.stderr.write(`Unexpected Gate 0 lifecycle command: ${JSON.stringify(command)}\n`);
      void stop(1);
      continue;
    }
    void stop(0);
  }
});

try {
  await agent.start();
  const internals = agent as unknown as HarnessAgentInternals;
  const persistence = internals.rfc64PersistenceV1;
  if (!internals.started || persistence === undefined || persistence.closed) {
    throw new Error('production DKGAgent did not own an open RFC-64 persistence boundary');
  }
  ownedPersistence = persistence;

  // A production inventory operation through the DKGAgent-owned, non-lifecycle
  // view. The opaque empty session is process-local and intentionally needs no
  // durable cleanup; successful creation proves the inventory is operational.
  persistence.inventory.createCandidateSession();

  let staged = false;
  if (shouldStage) {
    const result = await persistence.controlObjects.stageVerifiedObjects([{
      envelope: expected.envelope,
      issuerSignature: expected.issuerSignature,
    }]);
    if (!result.durable || result.objects.length !== 1) {
      throw new Error('control-object stage did not report one durable object');
    }
    if (
      result.objects[0].objectDigest !== expected.objectDigest
      || result.objects[0].signatureVariantDigest !== expected.signatureVariantDigest
    ) {
      throw new Error('control-object stage returned unexpected digest keys');
    }
    staged = true;
  }

  const stored = await persistence.controlObjects.getVerifiedObject({
    objectDigest: expected.objectDigest,
    signatureVariantDigest: expected.signatureVariantDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  const storedSplit = stored === null
    ? null
    : splitCanonicalSignedControlEnvelopeV1(stored.envelope);
  const expectedSplit = splitCanonicalSignedControlEnvelopeV1(expected.envelope);
  if (
    storedSplit === null
    || !Buffer.from(storedSplit.unsignedEnvelopeBytes)
      .equals(Buffer.from(expectedSplit.unsignedEnvelopeBytes))
    || !Buffer.from(storedSplit.signatureVariantBytes)
      .equals(Buffer.from(expectedSplit.signatureVariantBytes))
  ) {
    throw new Error('agent-owned control store did not return the exact verified fixture');
  }

  emit({
    event: 'ready',
    agentClass: agent.constructor.name,
    agentStarted: internals.started,
    inventoryOperational: true,
    persistenceClosed: persistence.closed,
    namespaceDurability: persistence.controlObjects.namespaceDurability,
    objectDigest: expected.objectDigest,
    signatureVariantDigest: expected.signatureVariantDigest,
    staged,
    verifiedRead: true,
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await stop(1);
}

// Keep the real agent process alive while the parent proves exclusive lease
// ownership and snapshots immutable durable bytes. Timers are deliberately not
// used as an observation or test seam.
await new Promise<never>(() => undefined);
