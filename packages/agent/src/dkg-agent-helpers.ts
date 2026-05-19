// SPDX-License-Identifier: Apache-2.0

/**
 * Stateless free helpers extracted from `dkg-agent.ts` as part of a
 * mechanical file-size reduction. None of these touch a `DKGAgent`
 * instance — every function is pure (or pure-with-ethers), takes its
 * inputs explicitly, and is safely callable from any caller. Behaviour
 * is unchanged.
 *
 * Topical buckets, in declaration order:
 *  - Publish-payload normalisation / partitioning.
 *  - EIP-712 sign + attestation byte ↔ hex conversions.
 *  - Agent-DID and join-delegation scope normalisation.
 *  - Sync-phase normalisation.
 *  - ChainAdapter publisher-address discovery (probes the various
 *    optional adapter surfaces and returns the first valid address).
 *  - Triple-store config defaults (large-literal storage, public SWM
 *    snapshot store).
 */

import { ethers } from 'ethers';
import { join } from 'node:path';
import {
  autoPartition,
  FileWorkspacePublicSnapshotStore,
  type LiftRequestAuthorSeal,
  type SharedMemoryPublicSnapshotStorageConfig,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type {
  Quad,
  TripleStoreConfig,
  LargeLiteralStorageConfig,
} from '@origintrail-official/dkg-storage';
import type { AuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { SyncPhase } from './sync/auth/request-build.js';
import { PRIVATE_DATA_ANCHOR } from './dkg-agent-constants.js';
import { InvalidContentError, type PublishAsyncQuadEnvelope } from './dkg-agent-types.js';

// ── Publish-payload normalisation ─────────────────────────────────────

export function normalizePublishContextGraphId(input: string): string {
  const value = String(input).trim().replace(/^<(.+)>$/, '$1');
  const prefix = 'did:dkg:context-graph:';
  if (!value.startsWith(prefix)) return value;
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(0, slash) : rest;
}

export function isPublishAsyncQuadEnvelope(input: unknown): input is PublishAsyncQuadEnvelope {
  return !!input
    && typeof input === 'object'
    && !Array.isArray(input)
    && ('publicQuads' in input || 'privateQuads' in input);
}

export function assertQuadArray(value: unknown, fieldName: string): Quad[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidContentError(`${fieldName} must be an array of RDF quads`);
  }
  for (const quad of value) {
    if (
      !quad
      || typeof quad.subject !== 'string'
      || typeof quad.predicate !== 'string'
      || typeof quad.object !== 'string'
    ) {
      throw new InvalidContentError(`${fieldName} must contain RDF quads with subject, predicate, and object strings`);
    }
  }
  return value.map((quad) => ({ ...quad, graph: quad.graph ?? '' })) as Quad[];
}

export function partitionPublishAsyncQuads(publicQuads: Quad[], privateQuads: Quad[]): {
  publicQuads: Quad[];
  privateQuadsByRoot: Map<string, Quad[]>;
  roots: string[];
} {
  const privateByRoot = autoPartition(privateQuads);
  let stagedPublicQuads = [...publicQuads];
  let publicByRoot = autoPartition(stagedPublicQuads);

  for (const rootEntity of privateByRoot.keys()) {
    if (!publicByRoot.has(rootEntity)) {
      stagedPublicQuads.push({
        subject: rootEntity,
        predicate: PRIVATE_DATA_ANCHOR,
        object: '"true"',
        graph: '',
      });
    }
  }

  publicByRoot = autoPartition(stagedPublicQuads);
  const roots = [...publicByRoot.keys()];
  if (roots.length === 0) {
    throw new InvalidContentError('Content produced no publishable root entities');
  }

  return {
    publicQuads: stagedPublicQuads,
    privateQuadsByRoot: privateByRoot,
    roots,
  };
}

// ── EIP-712 sign + attestation byte ↔ hex conversions ────────────────

/** Sign EIP-712 typed data with a raw private key, returning compact (r, vs). */
export async function signWithPrivateKey(
  privateKey: string,
  typedData: AuthorAttestationTypedData,
): Promise<{ r: Uint8Array; vs: Uint8Array }> {
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
  const sigHex = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  const sig = ethers.Signature.from(sigHex);
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

/** Bytes → hex for lift-queue persistence. Inverse: `liftSealToPrecomputedAttestation`. */
export function preSignedAttestationToLiftSeal(input: {
  expectedMerkleRoot: Uint8Array;
  authorAddress: string;
  signature: { r: Uint8Array; vs: Uint8Array };
  schemeVersion: number;
}): LiftRequestAuthorSeal {
  return {
    merkleRoot: ethers.hexlify(input.expectedMerkleRoot) as `0x${string}`,
    authorAddress: input.authorAddress as `0x${string}`,
    signature: {
      r: ethers.hexlify(input.signature.r) as `0x${string}`,
      vs: ethers.hexlify(input.signature.vs) as `0x${string}`,
    },
    schemeVersion: input.schemeVersion,
  };
}

// ── DID + delegation-scope normalisation ──────────────────────────────

/**
 * Normalise an `did:dkg:agent:<id>` DID for case-insensitive equality
 * comparison. The agent ID can be either an Ethereum address (which IS
 * case-insensitive on the wire — checksum is purely advisory per
 * EIP-55) or a libp2p peer ID (which is NOT case-insensitive — base58
 * has uppercase characters that carry information). The previous
 * approach lower-cased the entire DID, which works in practice because
 * peer IDs round-trip the same way on both sides of a comparison, but
 * is semantically wrong: a non-EVM owner DID could in principle be
 * stored with one case and read back with another. Make the
 * normalisation explicit and only touch the EVM-address suffix.
 */
export function normalizeAgentDid(did: string): string {
  const m = did.match(/^did:dkg:agent:(0x[0-9a-fA-F]{40})$/);
  if (m) return `did:dkg:agent:${m[1].toLowerCase()}`;
  return did;
}

/**
 * Scope string for join-request delegations. Authorises the named node
 * to sync the CG on the named DKG deployment.
 *
 * The `deploymentId` (e.g. `evm:84532:hub=0x...`) namespaces the scope
 * to a SPECIFIC deployment, not just a chain — every Hardhat instance
 * shares `evm:31337`, and a single chain can host multiple independent
 * DKG deployments with different Hub contracts. Without deployment-id
 * binding, a delegation signed against testnet's CG "X" could be
 * replayed against a devnet's CG "X" with the same delegatee
 * identifiers. See `ChainAdapter.deploymentId`.
 *
 * Fails closed if `deploymentId` is empty/undefined. `ChainAdapter` is
 * a TypeScript-only interface, so a JS / cast / custom adapter can omit
 * the field at runtime; without this guard we'd silently sign and
 * verify against `sync:deployment=undefined:<cgId>`, dropping the
 * cross-deployment replay protection this scope is meant to add.
 * PR #448 review (round 4): make misconfigured adapters fail loudly
 * instead of minting broad delegations.
 */
export function joinDelegationScope(deploymentId: string | undefined, contextGraphId: string): string {
  if (!deploymentId || typeof deploymentId !== 'string' || deploymentId.trim().length === 0) {
    throw new Error(
      'Cannot derive join-delegation scope: chain adapter did not advertise a deploymentId. '
      + 'Every adapter (EVM, mock, custom) must implement `get deploymentId(): string` so '
      + 'delegations can\'t be cross-deployment replayed. Update the adapter or wrap it.',
    );
  }
  return `sync:deployment=${deploymentId}:${contextGraphId}`;
}

// ── Sync-phase normalisation ──────────────────────────────────────────

export function normalizeSyncPhase(value: unknown): SyncPhase {
  if (value === 'meta' || value === 'snapshot') return value;
  return 'data';
}

// ── ChainAdapter publisher-address discovery ──────────────────────────

export function normalizeAdapterPublisherAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ethers.isAddress(value)) return undefined;
  const address = ethers.getAddress(value);
  return address === ethers.ZeroAddress ? undefined : address;
}

export function recoverCompactSigner(message: Uint8Array, compact: { r: Uint8Array; vs: Uint8Array }): string {
  const signature = ethers.Signature.from({
    r: ethers.hexlify(compact.r),
    yParityAndS: ethers.hexlify(compact.vs),
  }).serialized;
  return ethers.verifyMessage(message, signature);
}

export function adapterOperationalPrivateKeyAddress(chain: ChainAdapter): string | undefined {
  const operationalKeyGetter = (chain as unknown as { getOperationalPrivateKey?: () => unknown })
    .getOperationalPrivateKey;
  if (typeof operationalKeyGetter !== 'function') return undefined;
  try {
    const privateKey = operationalKeyGetter.call(chain);
    return typeof privateKey === 'string' && privateKey.length > 0
      ? privateKeyAddress(privateKey)
      : undefined;
  } catch {
    return undefined;
  }
}

export function adapterHasOperationalPrivateKey(chain: ChainAdapter): boolean {
  return adapterOperationalPrivateKeyAddress(chain) !== undefined;
}

export async function adapterGenericSignMessageMatchesAddress(
  chain: ChainAdapter,
  expectedAddress: string,
): Promise<boolean> {
  if (chain.chainId === 'none' || typeof chain.signMessage !== 'function') return false;
  const normalized = normalizeAdapterPublisherAddress(expectedAddress);
  if (!normalized) return false;

  try {
    const challenge = ethers.getBytes(ethers.id(`dkg-agent:chain-signer-probe:${normalized.toLowerCase()}`));
    const compact = await chain.signMessage(challenge);
    const recovered = normalizeAdapterPublisherAddress(recoverCompactSigner(challenge, compact));
    return recovered?.toLowerCase() === normalized.toLowerCase();
  } catch {
    return false;
  }
}

export async function adapterAdvertisesPublisherSigner(chain: ChainAdapter): Promise<boolean> {
  const hasReservingOrMultiAddressProbe = typeof chain.getAuthorizedPublisherAddress === 'function' ||
    typeof (chain as unknown as { getSignerAddresses?: unknown }).getSignerAddresses === 'function';
  const hasSingleAddressProbe = typeof (chain as unknown as { getSignerAddress?: unknown }).getSignerAddress === 'function' ||
    Boolean(normalizeAdapterPublisherAddress((chain as unknown as { signerAddress?: unknown }).signerAddress));
  const hasAnyAddressProbe = hasReservingOrMultiAddressProbe || hasSingleAddressProbe;

  if (typeof chain.signMessageAs === 'function') return hasAnyAddressProbe;
  if (adapterHasOperationalPrivateKey(chain)) return true;
  if (typeof chain.signMessage !== 'function') return false;

  const advertisedAddress = await inferAdapterPublisherAddress(chain, undefined, {
    includeReservingPublisherProbe: false,
    includeGenericSignMessageProbe: false,
  });
  if (!advertisedAddress) return false;
  return adapterGenericSignMessageMatchesAddress(chain, advertisedAddress);
}

export function privateKeyAddress(privateKey: string | undefined): string | undefined {
  if (!privateKey) return undefined;
  try {
    return normalizeAdapterPublisherAddress(new ethers.Wallet(privateKey).address);
  } catch {
    return undefined;
  }
}

export async function inferAdapterPublisherAddress(
  chain: ChainAdapter,
  contextGraphId?: bigint,
  options?: {
    includeReservingPublisherProbe?: boolean;
    includeGenericSignMessageProbe?: boolean;
  },
): Promise<string | undefined> {
  if (
    options?.includeReservingPublisherProbe !== false &&
    contextGraphId !== undefined &&
    typeof chain.getAuthorizedPublisherAddress === 'function'
  ) {
    try {
      const address = normalizeAdapterPublisherAddress(
        await chain.getAuthorizedPublisherAddress(contextGraphId),
      );
      if (address) return address;
    } catch {
      // Best-effort probe; the publisher resolver retries on later publish/update attempts.
    }
  }

  const signerAddressGetter = (chain as unknown as { getSignerAddress?: () => unknown }).getSignerAddress;
  if (typeof signerAddressGetter === 'function') {
    try {
      const address = normalizeAdapterPublisherAddress(
        await Promise.resolve(signerAddressGetter.call(chain)),
      );
      if (address) return address;
    } catch {
      // Best-effort probe; fall through to broader adapter surfaces.
    }
  }

  const signerAddresses = (chain as unknown as { getSignerAddresses?: () => unknown }).getSignerAddresses;
  if (typeof signerAddresses === 'function') {
    try {
      const advertised = await Promise.resolve(signerAddresses.call(chain));
      if (Array.isArray(advertised)) {
        for (const value of advertised) {
          const address = normalizeAdapterPublisherAddress(value);
          if (address) return address;
        }
      }
    } catch {
      // Best-effort probe; the publisher resolver retries on later publish/update attempts.
    }
  }

  const signerAddress = normalizeAdapterPublisherAddress(
    (chain as unknown as { signerAddress?: unknown }).signerAddress,
  );
  if (signerAddress) return signerAddress;

  const adapterOperationalAddress = adapterOperationalPrivateKeyAddress(chain);
  if (adapterOperationalAddress) return adapterOperationalAddress;

  if (options?.includeGenericSignMessageProbe === false) return undefined;
  if (chain.chainId === 'none' || typeof chain.signMessage !== 'function') return undefined;

  try {
    const challenge = ethers.getBytes(ethers.id('dkg-agent:publisher-address-probe'));
    const compact = await chain.signMessage(challenge);
    return normalizeAdapterPublisherAddress(recoverCompactSigner(challenge, compact));
  } catch {
    return undefined;
  }
}

// ── Triple-store config defaults ──────────────────────────────────────

export function defaultLargeLiteralStorage(
  dataDir: string,
  config: LargeLiteralStorageConfig | undefined,
): LargeLiteralStorageConfig {
  return {
    enabled: config?.enabled ?? true,
    thresholdBytes: config?.thresholdBytes,
    directory: config?.directory ?? join(dataDir, 'literal-blobs'),
  };
}

export function createPublicSnapshotStore(
  dataDir: string | undefined,
  config: SharedMemoryPublicSnapshotStorageConfig | undefined,
): WorkspacePublicSnapshotStore | undefined {
  if (!dataDir || config?.enabled === false) return undefined;
  return new FileWorkspacePublicSnapshotStore(config?.directory ?? join(dataDir, 'swm-public-snapshots'));
}

export function applyDefaultLargeLiteralStorage(
  storeConfig: TripleStoreConfig,
  dataDir: string | undefined,
  config: LargeLiteralStorageConfig | undefined,
): TripleStoreConfig {
  if (storeConfig.largeLiteralStorage || !dataDir || !isLocalOxigraphConfig(storeConfig)) {
    return storeConfig;
  }

  return {
    ...storeConfig,
    largeLiteralStorage: defaultLargeLiteralStorage(dataDir, config),
  };
}

export function isLocalOxigraphConfig(storeConfig: TripleStoreConfig): boolean {
  return storeConfig.backend === 'oxigraph'
    || storeConfig.backend === 'oxigraph-worker'
    || storeConfig.backend === 'oxigraph-persistent';
}
