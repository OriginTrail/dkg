import { computePublishPublisherDigest } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

type PeerId = { toString(): string };

export interface PublishGatewayHandlerConfig {
  nodeRole: 'core' | 'edge';
  nodeIdentityId: bigint;
  signerWallet: ethers.Wallet;
  chainId: bigint;
  kav10Address: string;
  pcaAccountId?: bigint;
  paymaster?: string;
  /**
   * Optional libp2p peer-id allowlist. When set (and non-empty), the
   * handler refuses to sign requests from peers not in this set. Without
   * an allowlist any connected peer can ask this core to sign publisher
   * digests under its identity — for an open context graph that means
   * arbitrary peers can attribute produced value to this node, and a
   * gateway that advertises a paymaster effectively gets its sponsor
   * free publishes from every peer it ever talks to. Operators advertising
   * a paymaster MUST configure this; cores operating without paymaster
   * may keep it open to preserve the current devnet flow at the cost of
   * the produced-value attribution risk above.
   */
  allowedPeers?: Set<string>;
  isActiveCore?: () => Promise<boolean>;
  isPaymasterValid?: (paymaster: string) => Promise<boolean>;
  getConvictionAccountInfo?: (accountId: bigint) => Promise<unknown | null>;
}

export interface PublishGatewayRequestWire {
  chainId?: string;
  kav10Address?: string;
  contextGraphId: string;
  merkleRoot: string;
  nodeIdentityId?: string;
  pcaAccountId?: string;
  paymaster?: string;
}

export interface PublishGatewayResponseWire {
  error?: string;
  nodeIdentityId?: string;
  signer?: string;
  signatureR?: string;
  signatureVS?: string;
  pcaAccountId?: string;
  paymaster?: string;
}

/**
 * Core-node side of the preferred publish gateway protocol.
 *
 * A gateway signs only the V10 publisher digest. It does not submit the
 * publish transaction, so the edge publisher remains `msg.sender` while the
 * gateway's node identity receives produced-value attribution on-chain.
 */
export class PublishGatewayHandler {
  private readonly config: PublishGatewayHandlerConfig;

  constructor(config: PublishGatewayHandlerConfig) {
    // Fail-closed invariant: a configured paymaster without a non-empty
    // peer allowlist would let any connected peer get sponsored
    // publishes, turning this core into an open sponsor endpoint. Catch
    // it at construction so the misconfiguration is surfaced before any
    // request reaches `handler` (and before the handler is registered
    // on the libp2p protocol surface).
    if (
      config.paymaster
      && ethers.getAddress(config.paymaster) !== ethers.ZeroAddress
      && (!config.allowedPeers || config.allowedPeers.size === 0)
    ) {
      throw new Error(
        'PublishGatewayHandler: paymaster is configured but allowedPeers is empty; ' +
        'refusing to construct an open sponsor endpoint',
      );
    }
    this.config = config;
  }

  handler = async (data: Uint8Array, peerId: PeerId): Promise<Uint8Array> => {
    try {
      if (this.config.nodeRole !== 'core') {
        throw new Error('Only core nodes can act as publish gateways');
      }
      if (this.config.nodeIdentityId <= 0n) {
        throw new Error('Publish gateway is unavailable: core node identity is not provisioned');
      }

      // Peer allowlist gate. We perform the check before parsing the
      // request body so unauthenticated peers cannot force unbounded
      // CPU work on the gateway.
      if (this.config.allowedPeers && this.config.allowedPeers.size > 0) {
        const requesterPeerId = peerId?.toString?.() ?? '';
        if (!requesterPeerId || !this.config.allowedPeers.has(requesterPeerId)) {
          throw new Error(
            `Publish gateway peer ${requesterPeerId || '<unknown>'} is not allowed`,
          );
        }
      }

      const request = decodeRequest(data);
      if (request.chainId !== undefined) {
        const requestedChainId = parsePositiveBigInt(request.chainId, 'chainId');
        if (requestedChainId !== this.config.chainId) {
          throw new Error(
            `Publish gateway chain mismatch: requested ${requestedChainId}, ` +
            `this core node signs for ${this.config.chainId}`,
          );
        }
      }
      if (request.kav10Address !== undefined) {
        const requestedKav = ethers.getAddress(request.kav10Address);
        if (requestedKav !== ethers.getAddress(this.config.kav10Address)) {
          throw new Error(
            `Publish gateway KnowledgeAssetsV10 mismatch: requested ${requestedKav}, ` +
            `this core node signs for ${ethers.getAddress(this.config.kav10Address)}`,
          );
        }
      }
      const requestedIdentity = request.nodeIdentityId ? parsePositiveBigInt(request.nodeIdentityId, 'nodeIdentityId') : undefined;
      if (requestedIdentity !== undefined && requestedIdentity !== this.config.nodeIdentityId) {
        throw new Error(
          `Publish gateway identity mismatch: requested ${requestedIdentity}, ` +
          `this core node is ${this.config.nodeIdentityId}`,
        );
      }

      const contextGraphId = parsePositiveBigInt(request.contextGraphId, 'contextGraphId');
      const merkleRoot = parseBytes32(request.merkleRoot, 'merkleRoot');
      const pcaAccountId = request.pcaAccountId
        ? parsePositiveBigInt(request.pcaAccountId, 'pcaAccountId')
        : undefined;
      const paymaster = request.paymaster ? ethers.getAddress(request.paymaster) : undefined;

      if (pcaAccountId !== undefined) {
        if (this.config.pcaAccountId !== pcaAccountId) {
          throw new Error(`Publish gateway PCA account ${pcaAccountId} unavailable`);
        }
        if (!this.config.getConvictionAccountInfo) {
          throw new Error(
            `Publish gateway PCA account ${pcaAccountId} unavailable: ` +
            'chain adapter cannot read conviction accounts',
          );
        }
        const account = await this.config.getConvictionAccountInfo(pcaAccountId);
        if (!account) {
          throw new Error(`Publish gateway PCA account ${pcaAccountId} unavailable`);
        }
      }

      if (paymaster) {
        const configuredPaymaster = this.config.paymaster
          ? ethers.getAddress(this.config.paymaster)
          : undefined;
        if (configuredPaymaster !== paymaster) {
          throw new Error(`Publish gateway paymaster ${paymaster} unavailable`);
        }
        if (!this.config.isPaymasterValid) {
          throw new Error(
            `Publish gateway paymaster ${paymaster} unavailable: ` +
            'chain adapter cannot verify paymaster status',
          );
        }
        if (!(await this.config.isPaymasterValid(paymaster))) {
          throw new Error(`Publish gateway paymaster ${paymaster} unavailable`);
        }
      }

      if (!this.config.isActiveCore) {
        throw new Error(
          'Publish gateway cannot confirm active sharding-table membership; refusing to sign',
        );
      }
      let activeCore: boolean;
      try {
        activeCore = await this.config.isActiveCore();
      } catch {
        throw new Error('Publish gateway active-core lookup failed; refusing to sign');
      }
      if (!activeCore) {
        throw new Error('Publish gateway identity is not an active sharding-table core node');
      }

      const digest = computePublishPublisherDigest(
        this.config.chainId,
        this.config.kav10Address,
        this.config.nodeIdentityId,
        contextGraphId,
        merkleRoot,
      );
      const signature = ethers.Signature.from(
        await this.config.signerWallet.signMessage(digest),
      );

      const response: PublishGatewayResponseWire = {
        nodeIdentityId: this.config.nodeIdentityId.toString(),
        signer: this.config.signerWallet.address,
        signatureR: signature.r,
        signatureVS: signature.yParityAndS,
        ...(pcaAccountId !== undefined ? { pcaAccountId: pcaAccountId.toString() } : {}),
        ...(paymaster ? { paymaster } : {}),
      };

      return new TextEncoder().encode(JSON.stringify(response));
    } catch (err) {
      return new TextEncoder().encode(JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };
}

function decodeRequest(data: Uint8Array): PublishGatewayRequestWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error('Invalid publish gateway request: expected JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid publish gateway request: expected object');
  }
  const request = parsed as Record<string, unknown>;
  if (typeof request.contextGraphId !== 'string') {
    throw new Error('Invalid publish gateway request: missing string contextGraphId');
  }
  if (typeof request.merkleRoot !== 'string') {
    throw new Error('Invalid publish gateway request: missing string merkleRoot');
  }
  for (const key of ['chainId', 'kav10Address', 'nodeIdentityId', 'pcaAccountId', 'paymaster']) {
    if (request[key] !== undefined && typeof request[key] !== 'string') {
      throw new Error(`Invalid publish gateway request: ${key} must be a string`);
    }
  }
  return request as unknown as PublishGatewayRequestWire;
}

function parsePositiveBigInt(value: string, field: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`Invalid publish gateway request: ${field} must be an integer string`);
  }
  if (parsed <= 0n) {
    throw new Error(`Invalid publish gateway request: ${field} must be positive`);
  }
  return parsed;
}

function parseBytes32(value: string, field: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid publish gateway request: ${field} must be a 32-byte hex string`);
  }
  return ethers.getBytes(value);
}
