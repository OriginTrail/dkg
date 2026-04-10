#!/usr/bin/env npx tsx
import { ethers, JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const HUB_ABI = [
  'function getContractAddress(string contractName) view returns (address)',
];

const CHAINS = [
  {
    name: 'Base',
    hubAddress: '0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13',
    rpcEnvKey: 'RPC_BASE_MAINNET',
    fallbackRpc: 'https://mainnet.base.org',
    expected: {
      KnowledgeCollectionStorage: '0xc28F310A87f7621A087A603E2ce41C22523F11d7',
      EpochStorageV8: '0x271Dd66348844bbe1d8bf838a4DAE5b4B7f558A1',
      Chronos: '0x07B1442717bbeD003ab2B2165B1b020F3F6B924B',
    },
  },
  {
    name: 'Gnosis',
    hubAddress: '0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f',
    rpcEnvKey: 'RPC_GNOSIS_MAINNET',
    fallbackRpc: 'https://rpc.gnosischain.com',
    expected: {
      KnowledgeCollectionStorage: '0x3Cb124E1cDcEECF6E464BB185325608dbe635f5D',
      EpochStorageV8: '0x054f356265E7E43f3E1641D00cDF51E762e8Cd58',
      Chronos: '0x0913cBBbF760D53A88915a0CFF57ED8A3409b4fe',
    },
  },
  {
    name: 'NeuroWeb',
    hubAddress: '0x0957e25BD33034948abc28204ddA54b6E1142D6F',
    rpcEnvKey: 'RPC_NEUROWEB_MAINNET',
    fallbackRpc: 'https://pulsar.neuroweb.ai/',
    expected: {
      KnowledgeCollectionStorage: '0x8f678eB0E57ee8A109B295710E23076fA3a443fe',
      EpochStorageV8: '0x079C6744ed723Df6da6d18c56520362569D5448A',
      Chronos: '0xCFb72d5F0C888Be93d67EeaAf6Daac8507D85853',
    },
  },
];

const CONTRACT_NAMES = [
  'KnowledgeCollectionStorage',
  'EpochStorageV8',
  'Chronos',
];

async function main() {
  for (const chain of CHAINS) {
    const rpcUrls = (process.env[chain.rpcEnvKey] ?? chain.fallbackRpc).split(',').map(u => u.trim());
    let provider: JsonRpcProvider | null = null;
    for (const url of rpcUrls) {
      try {
        const p = new JsonRpcProvider(url);
        await p.getBlockNumber();
        provider = p;
        break;
      } catch {}
    }
    if (!provider) {
      console.log(`\n${chain.name}: ALL RPCs FAILED`);
      continue;
    }

    const hub = new Contract(chain.hubAddress, HUB_ABI, provider);
    console.log(`\n=== ${chain.name} (Hub: ${chain.hubAddress}) ===`);

    for (const name of CONTRACT_NAMES) {
      try {
        const onChain: string = await hub.getContractAddress(name);
        const expected = (chain.expected as any)[name] as string;
        const match = onChain.toLowerCase() === expected.toLowerCase();
        const status = match ? '✓' : '✗ MISMATCH';
        console.log(`  ${name}:`);
        console.log(`    On-chain: ${onChain}`);
        console.log(`    Script:   ${expected}`);
        console.log(`    ${status}`);
      } catch (e: any) {
        console.log(`  ${name}: ERROR — ${e.message?.substring(0, 100)}`);
      }
    }
  }
}

main().catch(console.error);
