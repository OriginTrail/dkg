import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT, type KadDHT } from '@libp2p/kad-dht';
import { gossipsub, type GossipSub } from '@libp2p/gossipsub';
import { mdns } from '@libp2p/mdns';
import { identify } from '@libp2p/identify';
import { ping, type Ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import type { DKGNodeConfig } from './types.js';
import { DHT_PROTOCOL } from './constants.js';

export interface DKGServices extends Record<string, unknown> {
  dht: KadDHT;
  pubsub: GossipSub;
  identify: unknown;
  ping: Ping;
  dcutr: unknown;
  autoNAT?: unknown;
  relay?: unknown;
}

export class DKGNode {
  private node: Libp2p<DKGServices> | null = null;
  private readonly config: DKGNodeConfig;

  constructor(config: DKGNodeConfig = {}) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.node) return;

    const privateKey = this.config.privateKey
      ? privateKeyFromRaw(this.config.privateKey)
      : await generateKeyPair('Ed25519');

    const peerDiscovery = [];
    if (this.config.bootstrapPeers && this.config.bootstrapPeers.length > 0) {
      peerDiscovery.push(bootstrap({ list: this.config.bootstrapPeers }));
    }
    if (this.config.enableMdns !== false) {
      peerDiscovery.push(mdns());
    }

    const transports: any[] = [tcp(), webSockets(), circuitRelayTransport()];

    // Nodes that already know their NAT status skip autoNAT probing:
    // - relayPeers set → agent behind NAT (knows it needs relay)
    // - enableRelayServer → public node acting as relay
    const useAutoNAT = this.config.enableAutoNAT ??
      !(this.config.relayPeers?.length || this.config.enableRelayServer);

    const services: Record<string, any> = {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ protocol: DHT_PROTOCOL }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
      }),
      dcutr: dcutr(),
    };

    if (useAutoNAT) {
      services.autoNAT = autoNAT();
    }

    if (this.config.enableRelayServer) {
      services.relay = circuitRelayServer({
        reservations: {
          maxReservations: 256,
          defaultDurationLimit: 5 * 60 * 1000,
          defaultDataLimit: BigInt(1 << 24),
        },
      });
    }

    const listenAddrs = [
      ...(this.config.listenAddresses ?? [
        '/ip4/0.0.0.0/tcp/0',
        '/ip4/0.0.0.0/tcp/0/ws',
      ]),
    ];

    // When relay peers are configured, listen on circuit addresses to ensure
    // the node requests a reservation and becomes reachable through relays.
    if (this.config.relayPeers?.length) {
      listenAddrs.push('/p2p-circuit');
    }

    this.node = await createLibp2p<DKGServices>({
      privateKey,
      addresses: { listen: listenAddrs },
      transports: transports as any,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services,
      connectionManager: {
        minConnections: 0,
      },
    } as any);

    // Connect to relay peers and tag them as keep-alive so libp2p's
    // connection manager maintains the connection and auto-redials.
    if (this.config.relayPeers?.length) {
      const { multiaddr } = await import('@multiformats/multiaddr');

      for (const addr of this.config.relayPeers) {
        const ma = multiaddr(addr);
        const p2pComponent = ma.getComponents().find(c => c.name === 'p2p');
        if (!p2pComponent?.value) continue;

        const peerId = peerIdFromString(p2pComponent.value);
        await this.node.peerStore.merge(peerId, {
          multiaddrs: [ma],
          tags: {
            'keep-alive-dkg-relay': { value: 100 },
          },
        });

        try {
          await this.node.dial(ma);
        } catch {
          // libp2p will auto-reconnect via the keep-alive tag
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    await this.node.stop();
    this.node = null;
  }

  get peerId(): string {
    return this.requireNode().peerId.toString();
  }

  get peerIdBytes(): Uint8Array {
    return this.requireNode().peerId.toMultihash().bytes;
  }

  get multiaddrs(): string[] {
    return this.requireNode()
      .getMultiaddrs()
      .map((ma) => ma.toString());
  }

  get libp2p(): Libp2p<DKGServices> {
    return this.requireNode();
  }

  get isStarted(): boolean {
    return this.node !== null;
  }

  private requireNode(): Libp2p<DKGServices> {
    if (!this.node) throw new Error('DKGNode not started');
    return this.node;
  }
}
