import { generateEd25519Keypair, ed25519Sign, type Ed25519Keypair } from '@dkg/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentWallet {
  readonly masterKey: Uint8Array;
  readonly keypair: Ed25519Keypair;
  peerId(): string;
  deriveEvmWallet(): EvmWallet;
  deriveSolanaWallet(): SolanaWallet;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface EvmWallet {
  address: string;
  privateKey: Uint8Array;
  sign(data: Uint8Array): Uint8Array;
}

export interface SolanaWallet {
  address: string;
  privateKey: Uint8Array;
  sign(data: Uint8Array): Uint8Array;
}

/**
 * SLIP-10 child key derivation for Ed25519.
 * Derives a child key from a parent key and chain code using a hardened index.
 */
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
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  };
}

/**
 * SLIP-10 master key derivation from seed.
 */
function slip10MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  };
}

/**
 * Derive a key at a BIP-44 path using SLIP-10 (for Ed25519 paths)
 * or raw HMAC-SHA512 (for secp256k1 paths).
 */
function deriveSlip10Path(seed: Uint8Array, path: number[]): Uint8Array {
  let { key, chainCode } = slip10MasterKey(seed);
  for (const index of path) {
    ({ key, chainCode } = slip10DeriveChild(key, chainCode, index));
  }
  return key;
}

/**
 * Derive a secp256k1 private key for EVM using BIP-32-like HMAC derivation.
 * Uses "Bitcoin seed" as the HMAC key per BIP-32 spec.
 */
function deriveEvmKey(seed: Uint8Array): Uint8Array {
  const I = hmac(sha512, new TextEncoder().encode('Bitcoin seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  const path = [44, 60, 0, 0, 0];
  for (const index of path) {
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(key, 1);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint32(33, (index | 0x80000000) >>> 0, false);
    const child = hmac(sha512, chainCode, data);
    key = child.slice(0, 32);
    chainCode = child.slice(32);
  }

  return key;
}

function evmAddressFromPrivateKey(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  const hash = sha256(pubKey);
  return '0x' + bytesToHex(hash.slice(12));
}

function solanaAddressFromPrivateKey(privateKey: Uint8Array): string {
  const pubKey = ed25519.getPublicKey(privateKey);
  return bytesToHex(pubKey);
}

export class DKGAgentWallet implements AgentWallet {
  readonly masterKey: Uint8Array;
  readonly keypair: Ed25519Keypair;

  private constructor(masterKey: Uint8Array, keypair: Ed25519Keypair) {
    this.masterKey = masterKey;
    this.keypair = keypair;
  }

  static async generate(): Promise<DKGAgentWallet> {
    const keypair = await generateEd25519Keypair();
    return new DKGAgentWallet(keypair.secretKey.slice(0, 32), keypair);
  }

  static async fromSeed(seed: Uint8Array): Promise<DKGAgentWallet> {
    const keypair = await generateEd25519Keypair();
    const wallet = new DKGAgentWallet(seed.slice(0, 32), {
      secretKey: keypair.secretKey,
      publicKey: keypair.publicKey,
    });
    return wallet;
  }

  static async fromMasterKey(masterKey: Uint8Array): Promise<DKGAgentWallet> {
    const libp2pKey = deriveSlip10Path(masterKey, [0]);
    const publicKey = ed25519.getPublicKey(libp2pKey);
    return new DKGAgentWallet(masterKey, {
      secretKey: libp2pKey,
      publicKey,
    });
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

  deriveEvmWallet(): EvmWallet {
    const privateKey = deriveEvmKey(this.masterKey);
    const address = evmAddressFromPrivateKey(privateKey);
    return {
      address,
      privateKey,
      sign(data: Uint8Array): Uint8Array {
        const hash = sha256(data);
        return secp256k1.sign(hash, privateKey);
      },
    };
  }

  deriveSolanaWallet(): SolanaWallet {
    const privateKey = deriveSlip10Path(this.masterKey, [44, 501, 0]);
    const address = solanaAddressFromPrivateKey(privateKey);
    return {
      address,
      privateKey,
      sign(data: Uint8Array): Uint8Array {
        return ed25519.sign(data, privateKey);
      },
    };
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return ed25519Sign(data, this.keypair.secretKey);
  }
}
