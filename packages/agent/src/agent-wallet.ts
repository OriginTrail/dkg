import { ed25519Sign, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentWallet {
  readonly masterKey: Uint8Array;
  readonly keypair: Ed25519Keypair;
  peerId(): string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

function slip10DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parentKey, 1);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setUint32(33, (index | 0x80000000) >>> 0, false);

  const I = hmac(sha512, parentChainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function slip10MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveSlip10Path(seed: Uint8Array, path: number[]): Uint8Array {
  let { key, chainCode } = slip10MasterKey(seed);
  for (const index of path) {
    ({ key, chainCode } = slip10DeriveChild(key, chainCode, index));
  }
  return key;
}

export class DKGAgentWallet implements AgentWallet {
  readonly masterKey: Uint8Array;
  readonly keypair: Ed25519Keypair;

  private constructor(masterKey: Uint8Array, keypair: Ed25519Keypair) {
    this.masterKey = masterKey;
    this.keypair = keypair;
  }

  static async generate(): Promise<DKGAgentWallet> {
    const masterKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return DKGAgentWallet.fromMasterKey(masterKey);
  }

  static async fromMasterKey(masterKey: Uint8Array): Promise<DKGAgentWallet> {
    const libp2pKey = deriveSlip10Path(masterKey, [0]);
    const publicKey = ed25519.getPublicKey(libp2pKey);
    return new DKGAgentWallet(masterKey, { secretKey: libp2pKey, publicKey });
  }

  static async load(dataDir: string): Promise<DKGAgentWallet> {
    const keyPath = join(dataDir, 'agent-key.bin');
    const data = await readFile(keyPath);
    return DKGAgentWallet.fromMasterKey(new Uint8Array(data));
  }

  async save(dataDir: string): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const keyPath = join(dataDir, 'agent-key.bin');
    await writeFile(keyPath, this.masterKey, { mode: 0o600 });
  }

  peerId(): string {
    return bytesToHex(this.keypair.publicKey);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return ed25519Sign(data, this.keypair.secretKey);
  }
}
