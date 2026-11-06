// The scenario's public description, public.testnet.json: what anyone needs to
// follow it on the chain. Addresses and ids only, never a key or the seed.

import * as fs from 'fs';

import { ethers } from 'ethers';

import { ACTIVATION_EPOCH, BLOCKSCOUT, BUYERS, CHAIN_ID, EVENTS, EXPLORER, FIRST_EPOCH, HUB, PUBLIC_RPC, SELLERS, SERVICES } from './config';
import type { BuyerName } from './config';
import { buyerWallet, ownerWallet } from './keys';

export type PublicBuyer = {
  name: BuyerName;
  address: string;
  pays: 'wallet' | 'account';
  accountId: number | null;
  owner: string | null;
  discountBps: number;
  home: string;
};

export type PublicFile = {
  network: { chainId: number; hub: string; rpc: string; explorer: string; blockscout: string };
  activationEpoch: number;
  firstEpoch: number;
  sellers: { name: string; identityId: number; address: string }[];
  services: { label: string; serviceId: string; serviceClass: number; unit: string }[];
  buyers: PublicBuyer[];
  events: { epochOffset: number; atUtc: string; kind: string; who: string; note: string }[];
};

/** The file for `seed`, with the account ids known so far. */
export function publicFile(seed: Uint8Array, accountIds: Partial<Record<BuyerName, number>> = {}): PublicFile {
  return {
    network: { chainId: CHAIN_ID, hub: HUB, rpc: PUBLIC_RPC, explorer: EXPLORER, blockscout: BLOCKSCOUT },
    activationEpoch: ACTIVATION_EPOCH,
    firstEpoch: FIRST_EPOCH,
    sellers: SELLERS.map((s) => ({ name: s.name, identityId: s.identityId, address: s.address })),
    services: SERVICES.map((s) => ({ label: s.label, serviceId: ethers.id(s.label), serviceClass: Number(s.serviceClass), unit: s.unit })),
    buyers: BUYERS.map((b) => ({
      name: b.name,
      address: buyerWallet(seed, b.name).address,
      pays: b.pays,
      accountId: accountIds[b.name] ?? null,
      owner: b.account ? ownerWallet(seed, b.name).address : null,
      discountBps: b.account?.discountBps ?? 0,
      home: b.home,
    })),
    events: EVENTS.map((e) => ({ epochOffset: e.epochOffset, atUtc: e.atUtc, kind: e.kind, who: e.who, note: e.note })),
  };
}

export function writePublicFile(file: PublicFile, paths: readonly string[]): void {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  for (const p of paths) {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
  }
}

export function readPublicFile(path: string): PublicFile {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as PublicFile;
}
