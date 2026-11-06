// The smoke test's roles and keys. The owner and the seller sign with keys
// from the environment, never printed; the buyers and the session keys are
// derived from the owner key and the run label, so no key is ever stored. On
// the local fork, an owner or a seller without a key is impersonated.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { ethers } from 'ethers';
import type { HDNodeWallet, Signer } from 'ethers';

import type { BaseContracts } from '../contracts';
import { Fork } from '../fork';
import { Redactor } from '../report';

export type Roles = {
  owner?: Signer;
  ownerAddr?: string;
  ownerImpersonated: boolean;
  buyer?: HDNodeWallet;
  edgeBuyer?: HDNodeWallet;
  caSession?: HDNodeWallet;
  walletSession?: HDNodeWallet;
  edgeSession?: HDNodeWallet;
  seller?: Signer;
  sellerAddr?: string;
  sellerImpersonated: boolean;
};

/** FORK-ONLY: the owner without RFC27_SMOKE_OWNER_KEY, an address no one holds a key to. */
export const FORK_OWNER = ethers.getAddress(ethers.dataSlice(ethers.id('rfc27-smoke/fork-owner'), 12));
/** FORK-ONLY: the seed of the derived keys without an owner key. It is public, so fork-only. */
const FORK_SEED = ethers.id('rfc27-smoke/fork-only seed: no real key');

/** A private key from the environment, joined to the redactor before anything else. */
export function keyFromEnv(name: string, redactor: Redactor): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  redactor.add(v);
  const k = v.startsWith('0x') ? v : `0x${v}`;
  redactor.add(k);
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex private key`);
  return k;
}

/**
 * The key of `role` in run `run`: an HD root from the seed
 * keccak256(seed ‖ "rfc27-smoke/<run>/<role>"), where the seed is the owner key.
 */
function derive(hre: HardhatRuntimeEnvironment, redactor: Redactor, seed: string, run: string, role: string): HDNodeWallet {
  const w = ethers.HDNodeWallet.fromSeed(ethers.keccak256(ethers.concat([seed, ethers.toUtf8Bytes(`rfc27-smoke/${run}/${role}`)])));
  redactor.add(w.privateKey);
  return w.connect(hre.ethers.provider);
}

/** FORK-ONLY: the operational key of `node`, from its recent proof challenges in the fork's history. */
async function operationalAddressOf(hre: HardhatRuntimeEnvironment, c: BaseContracts, node: bigint, blocks = 3_600): Promise<string | undefined> {
  const topic = ethers.id('ChallengeGenerated(uint72,uint256,uint256,uint256,uint256,uint256)');
  const nodeTopic = ethers.zeroPadValue(ethers.toBeHex(node), 32);
  const head = await hre.ethers.provider.getBlockNumber();
  // A public endpoint limits eth_getLogs to a range of 200 blocks.
  for (let to = head; to > head - blocks; to -= 199) {
    const logs = await hre.ethers.provider.getLogs({ address: c.randomSampling, topics: [topic, nodeTopic], fromBlock: to - 198, toBlock: to });
    for (const l of logs.reverse()) {
      const tx = await hre.ethers.provider.getTransaction(l.transactionHash);
      if (tx && (await c.ids.getIdentityId(tx.from)) === node) return tx.from;
    }
  }
  return undefined;
}

export async function roles(o: { hre: HardhatRuntimeEnvironment; fork: Fork; redactor: Redactor; c: BaseContracts; run: string }): Promise<Roles> {
  const { hre, fork, redactor, c, run } = o;
  const ownerKey = keyFromEnv('RFC27_SMOKE_OWNER_KEY', redactor);
  const sellerKey = keyFromEnv('RFC27_SMOKE_SELLER_KEY', redactor);
  const r: Roles = { ownerImpersonated: false, sellerImpersonated: false };
  let seed: string | undefined;
  if (ownerKey) {
    const w = new ethers.Wallet(ownerKey, hre.ethers.provider);
    r.owner = w;
    r.ownerAddr = w.address;
    seed = ownerKey;
  } else if (fork.net.local) {
    r.owner = await fork.impersonate(FORK_OWNER);
    r.ownerAddr = FORK_OWNER;
    r.ownerImpersonated = true;
    seed = FORK_SEED;
  }
  if (seed) {
    r.buyer = derive(hre, redactor, seed, run, 'buyer');
    r.edgeBuyer = derive(hre, redactor, seed, run, 'edge-buyer');
    r.caSession = derive(hre, redactor, seed, run, 'ca-session');
    r.walletSession = derive(hre, redactor, seed, run, 'wallet-session');
    r.edgeSession = derive(hre, redactor, seed, run, 'edge-session');
  }
  if (sellerKey) {
    const w = new ethers.Wallet(sellerKey, hre.ethers.provider);
    r.seller = w;
    r.sellerAddr = w.address;
  } else if (fork.net.local) {
    let a = process.env.RFC27_SMOKE_SELLER_ADDRESS;
    const id = process.env.RFC27_SMOKE_SELLER_ID;
    if (!a && id) {
      a = await operationalAddressOf(hre, c, BigInt(id));
      if (!a) throw new Error(`no proof of node ${id} in the recent blocks: set RFC27_SMOKE_SELLER_ADDRESS`);
    }
    if (a) {
      r.sellerAddr = ethers.getAddress(a);
      r.seller = await fork.impersonate(r.sellerAddr);
      r.sellerImpersonated = true;
    }
  }
  return r;
}

/** The roles a phase needs, which must be set. */
export function need<K extends keyof Roles>(r: Roles, keys: K[]): { [P in K]-?: NonNullable<Roles[P]> } {
  const missing = keys.filter((k) => r[k] === undefined);
  if (missing.length) {
    const vars = missing.some((k) => k === 'seller' || k === 'sellerAddr') ? 'RFC27_SMOKE_OWNER_KEY and RFC27_SMOKE_SELLER_KEY' : 'RFC27_SMOKE_OWNER_KEY';
    throw new Error(`this phase needs ${missing.join(', ')}: set ${vars}`);
  }
  return Object.fromEntries(keys.map((k) => [k, r[k]])) as { [P in K]-?: NonNullable<Roles[P]> };
}
