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
import type { DKGNodeConfig } from './types.js';
import { DHT_PROTOCOL } from './constants.js';

export interface DKGServices extends Record<string, unknown> {
  dht: KadDHT;
  pubsub: GossipSub;
  identify: unknown;
  ping: Ping;
  dcutr: unknown;
  autoNAT: unknown;
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

    const services: Record<string, any> = {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ protocol: DHT_PROTOCOL }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
      }),
      dcutr: dcutr(),
      autoNAT: autoNAT(),
    };

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
    } as any);

    // Connect to relay peers and maintain the connection
    if (this.config.relayPeers?.length) {
      const { multiaddr } = await import('@multiformats/multiaddr');
      const relayAddrs = this.config.relayPeers.map(a => multiaddr(a));

      const dialRelay = async (ma: ReturnType<typeof multiaddr>) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await this.node!.dial(ma);
            return true;
          } catch {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        return false;
      };

      for (const ma of relayAddrs) {
        await dialRelay(ma);
      }

      // Auto-reconnect to relay peers on disconnect
      this.node.addEventListener('peer:disconnect', (evt) => {
        const disconnectedId = evt.detail.toString();
        for (const ma of relayAddrs) {
          if (ma.toString().includes(disconnectedId)) {
            setTimeout(() => { dialRelay(ma); }, 2000);
          }
        }
      });
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
