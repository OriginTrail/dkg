import { peerIdFromString } from '@libp2p/peer-id';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import {
  WAL_CONTROL_MESSAGE,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
  WalWireError,
  WalWireProtocolClient,
  WalWireProtocolServer,
  type WalAuthorizedRequest,
  type WalWireLimitOverrides,
  type WalWireProtocolService,
} from '@origintrail-official/dkg-wal/protocol';
import type { ProtocolTuple } from '@origintrail-official/dkg-wal/protocol';
import { asWalRawProtocolRouter, registerWalWireProtocols } from './wire-protocol.js';

const CAPABILITY_NAMESPACE = new Uint8Array(32);

export interface DkgWalWireRuntimeOptions {
  readonly router: ProtocolRouter;
  readonly localPeerId: Uint8Array;
  readonly protocolVersion?: 1;
  readonly adapterVersion?: 1;
  readonly limits?: WalWireLimitOverrides;
  readonly authorizePeer: (peerId: string, request: WalAuthorizedRequest) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly randomRequestId?: () => Uint8Array;
}

function unavailable(method: string): never {
  throw new WalWireError(
    WAL_WIRE_ERROR_CODE.INTERNAL_UNAVAILABLE,
    `${method} is unavailable until its WAL task is active`,
  );
}

/**
 * First daemon-owned WAL transport slice. It advertises the complete frozen
 * protocol family, serves real capability negotiation, and fails every later
 * method closed until its backing task connects a service implementation.
 */
export class DkgWalWireRuntime {
  readonly capabilities: ProtocolTuple<'CapabilitiesV1'>;
  private readonly server: WalWireProtocolServer;
  private readonly client: WalWireProtocolClient;
  private unregister: (() => void) | null = null;

  constructor(private readonly options: DkgWalWireRuntimeOptions) {
    const protocolVersion = options.protocolVersion ?? 1;
    const adapterVersion = options.adapterVersion ?? 1;
    const service: WalWireProtocolService = {
      getCapabilities: async () => this.capabilities,
      getHead: async () => unavailable('GET_HEAD'),
      getVector: async () => unavailable('GET_VECTOR'),
      getCheckpoint: async () => unavailable('GET_CHECKPOINT'),
      announceHead: async () => unavailable('ANNOUNCE_HEAD'),
      getReconciliationSymbols: async () => unavailable('GET_RECONCILIATION_SYMBOLS'),
      getObjectIds: async () => unavailable('GET_OBJECT_IDS'),
      getObjectRange: async () => unavailable('GET_OBJECT_RANGE'),
    };
    this.server = new WalWireProtocolServer({
      localPeerId: options.localPeerId,
      service,
      authorize: request => options.authorizePeer(request.transportPeerId.toString(), request),
      limits: options.limits,
      now: options.now,
    });
    this.capabilities = [
      [BigInt(protocolVersion)],
      [BigInt(adapterVersion)],
      BigInt(this.server.limits.maximumFrameBytes),
      BigInt(this.server.limits.maximumSymbolsPerResponse),
      BigInt(this.server.limits.maximumFallbackIdsPerPage),
      BigInt(this.server.limits.maximumObjectRangeBytes),
      this.server.limits.maximumWalObjectBytes,
      BigInt(WAL_WIRE_LIMITS_V1.maximumConcurrentRangesPerPeer),
    ];
    this.client = new WalWireProtocolClient({
      router: asWalRawProtocolRouter(options.router),
      localPeerId: options.localPeerId,
      limits: options.limits,
      randomRequestId: options.randomRequestId,
    });
  }

  get started(): boolean {
    return this.unregister !== null;
  }

  start(): () => void {
    if (this.unregister !== null) throw new Error('WAL wire runtime is already started');
    const unregister = registerWalWireProtocols(this.options.router, this.server);
    this.unregister = unregister;
    return () => {
      if (this.unregister !== unregister) return;
      unregister();
      this.unregister = null;
    };
  }

  stop(): void {
    const unregister = this.unregister;
    if (unregister === null) return;
    unregister();
    this.unregister = null;
  }

  async getCapabilities(
    peerId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ProtocolTuple<'CapabilitiesV1'>> {
    if (!this.started) throw new Error('WAL wire runtime is not started');
    const targetPeerId = peerIdFromString(peerId).toMultihash().bytes;
    const context: ProtocolTuple<'RequestContextV1'> = [
      BigInt((this.options.now ?? Date.now)()),
      new Uint8Array(this.options.localPeerId),
      targetPeerId,
      CAPABILITY_NAMESPACE,
      null,
      null,
      null,
    ];
    return await this.client.request(
      peerId,
      'control',
      WAL_CONTROL_MESSAGE.GET_CAPABILITIES,
      context,
      [],
      options,
    ) as ProtocolTuple<'CapabilitiesV1'>;
  }
}

export function createDkgWalWireRuntime(options: DkgWalWireRuntimeOptions): DkgWalWireRuntime {
  return new DkgWalWireRuntime(options);
}
