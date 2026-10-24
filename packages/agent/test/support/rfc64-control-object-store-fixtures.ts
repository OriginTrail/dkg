import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeControlObjectDigestHex,
  computeControlSignatureVariantDigestHex,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

import {
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  type StageVerifiedControlObjectV1,
} from '../../src/rfc64/control-object-store-v1.js';

const PRIVATE_KEY = `0x${'42'.repeat(32)}`;

export const wallet = new ethers.Wallet(PRIVATE_KEY);
export const ISSUER = wallet.address.toLowerCase() as EvmAddressV1;

export function createTemporaryDataDirectoryFixture(): {
  readonly cleanup: () => Promise<void>;
  readonly temporaryDataDirectory: () => Promise<string>;
} {
  const temporaryDirectories: string[] = [];
  return {
    cleanup: async () => {
      await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
      }));
    },
    temporaryDataDirectory: async () => {
      const path = await mkdtemp(join(tmpdir(), 'dkg-rfc64-control-store-'));
      temporaryDirectories.push(path);
      return path;
    },
  };
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise?.() };
}

export async function signedFixture(
  sequence: string,
): Promise<StageVerifiedControlObjectV1> {
  const unsigned = {
    issuer: ISSUER,
    objectType: 'dkg-rfc64-control-store-test-v1',
    payload: { sequence },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } satisfies UnsignedControlEnvelopeV1;
  const objectDigest = computeControlObjectDigestHex(unsigned);
  const signature = await wallet.signMessage(ethers.getBytes(objectDigest));
  const envelope = {
    ...unsigned,
    objectDigest,
    signature,
  } as SignedControlEnvelopeV1;
  return {
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  };
}

export function pathsFor(
  dataDir: string,
  envelope: SignedControlEnvelopeV1,
): { root: string; object: string; signature: string; signatureDigest: Digest32V1 } {
  const root = join(dataDir, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH);
  const objectHex = envelope.objectDigest.slice(2);
  const signatureDigest = computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  ) as Digest32V1;
  return {
    root,
    object: join(root, 'objects', objectHex.slice(0, 2), `${objectHex}.jcs`),
    signature: join(
      root,
      'signatures',
      objectHex.slice(0, 2),
      objectHex,
      `${signatureDigest.slice(2)}.jcs`,
    ),
    signatureDigest,
  };
}
