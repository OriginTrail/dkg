import { ethers } from 'ethers';
import type { ChainAdapter, ContextGraphOnChain } from '@origintrail-official/dkg-chain';

export type DiscoveredContextGraphBinding =
  | {
    kind: 'unrevealed';
    registryNameHash: string | null;
  }
  | {
    kind: 'skipped';
    registryNameHash: string | null;
    rememberNameHash: boolean;
    warning: string;
  }
  | {
    kind: 'resolved';
    name: string;
    onChainId: string;
    registryNameHash: string | null;
  };

/**
 * Normalize the legacy ContextGraphOnChain identifier boundary before any
 * agent-local RDF or subscription mutation. Production EVM enumeration
 * returns a NameRegistry bytes32 key; custom adapters may already return the
 * positive decimal ContextGraphStorage id.
 */
export async function resolveDiscoveredContextGraphBinding(
  chain: ChainAdapter,
  entry: ContextGraphOnChain,
): Promise<DiscoveredContextGraphBinding> {
  const registryNameHash = ethers.isHexString(entry.contextGraphId, 32)
    ? entry.contextGraphId.toLowerCase()
    : null;

  if (!entry.name) {
    return { kind: 'unrevealed', registryNameHash };
  }

  if (registryNameHash) {
    const expectedNameHash = ethers.keccak256(ethers.toUtf8Bytes(entry.name)).toLowerCase();
    if (expectedNameHash !== registryNameHash) {
      return {
        kind: 'skipped',
        registryNameHash,
        rememberNameHash: true,
        warning:
          `Skipping revealed chain entry "${entry.name}": registry name hash ` +
          `${registryNameHash} does not match cleartext commitment ${expectedNameHash}`,
      };
    }

    const resolveByNameHash = chain.resolveContextGraphIdByNameHash;
    if (typeof resolveByNameHash !== 'function') {
      return {
        kind: 'skipped',
        registryNameHash,
        rememberNameHash: false,
        warning:
          `Skipping revealed chain entry "${entry.name}" (${registryNameHash.slice(0, 16)}…): ` +
          'chain adapter cannot resolve its numeric ContextGraphStorage id',
      };
    }

    // The adapter-owned resolver applies current-chain, reorg, and provider
    // consensus fences and revalidates the unique slot before returning it.
    const numericId = await resolveByNameHash.call(chain, registryNameHash);
    if (numericId === null || numericId <= 0n) {
      return {
        kind: 'skipped',
        registryNameHash,
        rememberNameHash: false,
        warning:
          `Skipping revealed chain entry "${entry.name}" (${registryNameHash.slice(0, 16)}…): ` +
          'no unique positive ContextGraphStorage id resolves from its name hash',
      };
    }

    return {
      kind: 'resolved',
      name: entry.name,
      onChainId: numericId.toString(),
      registryNameHash,
    };
  }

  if (/^[1-9][0-9]*$/.test(entry.contextGraphId)) {
    return {
      kind: 'resolved',
      name: entry.name,
      onChainId: entry.contextGraphId,
      registryNameHash: null,
    };
  }

  return {
    kind: 'skipped',
    registryNameHash: null,
    rememberNameHash: false,
    warning:
      `Skipping revealed chain entry "${entry.name}": invalid NameRegistry identifier ` +
      JSON.stringify(entry.contextGraphId),
  };
}
