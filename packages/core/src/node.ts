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
import { ed25519GetPublicKey } from './crypto/ed25519.js';
import type { ConnectionTransport, DKGNodeConfig } from './types.js';
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

const RELAY_WATCHDOG_BASE_INTERVAL_MS = 10_000;
const RELAY_WATCHDOG_MAX_INTERVAL_MS = 5 * 60_000;
/** Short delay before redialing a disconnected relay to avoid hammering (ms). */
const RELAY_REDIAL_DELAY_MS = 1_500;
/**
 * How long to allow a fresh reservation negotiation to complete after a relay
 * redial before the watchdog considers the relay unhealthy again. Circuit
 * Relay v2 reservation setup is usually sub-second on a healthy link, but we
 * give it a generous grace window to absorb transient latency.
 */
const RELAY_RESERVATION_GRACE_MS = 15_000;

interface RelayTarget {
  peerId: ReturnType<typeof peerIdFromString>;
  addr: any;
}

export class DKGNode {
  private node: Libp2p<DKGServices> | null = null;
  private readonly config: DKGNodeConfig;
  /** Peers currently connected only via relay (candidates for DCUtR upgrade). */
  private readonly relayedPeers = new Set<string>();
  private relayWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private relayTargets: RelayTarget[] = [];
  private relayWatchdogConsecutiveFailures = 0;
  /**
   * Per-relay timestamp of the last redial we issued specifically because the
   * circuit reservation had lapsed. Used to suppress spurious "reservation
   * missing" findings while a freshly re-dialed relay is still negotiating
   * the new reservation on the wire.
   */
  private relayReservationRedialAt: Map<string, number> = new Map();

  constructor(config: DKGNodeConfig = {}) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.node) return;

    let privateKey;
    if (this.config.privateKey) {
      // privateKeyFromRaw needs 64 bytes for Ed25519: seed(32) + publicKey(32)
      const seed = this.config.privateKey;
      const pub = await ed25519GetPublicKey(seed);
      const raw64 = new Uint8Array(64);
      raw64.set(seed, 0);
      raw64.set(pub, 32);
      privateKey = privateKeyFromRaw(raw64);
    } else {
      privateKey = await generateKeyPair('Ed25519');
    }

    const peerDiscovery = [];
    if (this.config.bootstrapPeers && this.config.bootstrapPeers.length > 0) {
      peerDiscovery.push(bootstrap({ list: this.config.bootstrapPeers }));
    }
    if (this.config.enableMdns !== false) {
      peerDiscovery.push(mdns());
    }

    // TCP keepAlive helps prevent idle relay connections from being dropped by
    // middleboxes or remote timeouts (common cause of ECONNRESET).
    const transports: any[] = [
      tcp({ dialOpts: { keepAlive: true } }),
      webSockets(),
      circuitRelayTransport(),
    ];

    const isCore = this.config.nodeRole === 'core';
    const enableRelay = this.config.enableRelayServer ?? isCore;

    // Nodes that already know their NAT status skip autoNAT probing:
    // - relayPeers set → agent behind NAT (knows it needs relay)
    // - enableRelayServer/core → public node acting as relay
    const useAutoNAT = this.config.enableAutoNAT ??
      !(this.config.relayPeers?.length || enableRelay);

    const services: Record<string, any> = {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ protocol: DHT_PROTOCOL }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        floodPublish: true,
        D: 4,
        Dlo: 2,
        Dhi: 8,
      }),
      dcutr: dcutr(),
    };

    if (useAutoNAT) {
      services.autoNAT = autoNAT();
    }

    if (enableRelay) {
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
      addresses: {
        listen: listenAddrs,
        ...(this.config.announceAddresses?.length
          ? { announce: this.config.announceAddresses }
          : {}),
      },
      transports: transports as any,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services,
      connectionManager: {
        minConnections: 0,
        // Reserve capacity for relay peers so they are not evicted under load.
        maxConnections: 500,
      },
    } as any);

    this.setupConnectionObservability();

    // Connect to relay peers and tag them as keep-alive so libp2p's
    // connection manager maintains the connection and auto-redials.
    if (this.config.relayPeers?.length) {
      const { multiaddr } = await import('@multiformats/multiaddr');

      for (const addr of this.config.relayPeers) {
        const ma = multiaddr(addr);
        const p2pComponent = ma.getComponents().find(c => c.name === 'p2p');
        if (!p2pComponent?.value) continue;

        const peerId = peerIdFromString(p2pComponent.value);
        if (peerId.equals(this.node.peerId)) continue;

        this.relayTargets.push({ peerId, addr: ma });

        await this.node.peerStore.merge(peerId, {
          multiaddrs: [ma],
          tags: {
            'keep-alive-dkg-relay': { value: 100 },
          },
        });

        try {
          await this.node.dial(ma);
        } catch {
          // watchdog will retry
        }
      }

      this.startRelayWatchdog();
    }
  }

  /**
   * Periodically check that relay connections are alive. After a network
   * outage (e.g. laptop sleep/wake) TCP sockets die silently and libp2p
   * won't automatically redial. Uses exponential backoff when the relay is
   * unreachable and resets to the base interval on successful reconnect.
   */
  private startRelayWatchdog(): void {
    if (this.relayWatchdogTimer) return;
    if (this.relayTargets.length === 0) return;

    this.scheduleWatchdogTick();
  }

  private scheduleWatchdogTick(): void {
    const delay = Math.min(
      RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
      RELAY_WATCHDOG_MAX_INTERVAL_MS,
    );

    this.relayWatchdogTimer = setTimeout(async () => {
      await this.watchdogTick();
      if (this.node) this.scheduleWatchdogTick();
    }, delay);

    if (this.relayWatchdogTimer.unref) {
      this.relayWatchdogTimer.unref();
    }
  }

  private async watchdogTick(): Promise<void> {
    const node = this.node;
    if (!node) return;

    const ts = () => new Date().toISOString();
    const short = (id: string) => id.slice(-8);
    let allHealthy = true;

    // Snapshot advertised self-multiaddrs once per tick so we can check which
    // relays still have a live /p2p-circuit reservation advertised via us.
    const selfAddrs = node.getMultiaddrs().map(ma => ma.toString());
    const now = Date.now();

    for (const { peerId, addr } of this.relayTargets) {
      if (peerId.equals(node.peerId)) continue;

      const relayPidStr = peerId.toString();
      const conns = node.getConnections(peerId);
      const transportUp = conns.length > 0;

      const hasReservation = selfAddrs.some(a =>
        a.includes(`/p2p/${relayPidStr}/p2p-circuit`),
      );

      // Happy path: transport connected AND we advertise a circuit address
      // through this relay → reservation is live.
      if (transportUp && hasReservation) {
        this.relayReservationRedialAt.delete(relayPidStr);
        continue;
      }

      // Transport is up but reservation is missing → either it has just been
      // re-negotiated and we're in the grace window, or it has genuinely
      // lapsed and we need to force a re-listen by dropping+redialing.
      if (transportUp && !hasReservation) {
        const lastForcedRedial = this.relayReservationRedialAt.get(relayPidStr) ?? 0;
        if (now - lastForcedRedial < RELAY_RESERVATION_GRACE_MS) {
          // We just redialed; give libp2p time to finish negotiating a new
          // reservation before declaring failure.
          allHealthy = false;
          continue;
        }

        allHealthy = false;
        console.log(
          `[${ts()}] Relay watchdog: reservation lapsed on ${short(relayPidStr)} ` +
          `(connection up, no /p2p-circuit self-addr) — dropping + redialing to force reserve`,
        );
        this.relayReservationRedialAt.set(relayPidStr, now);

        for (const c of conns) {
          try {
            await c.close();
          } catch {
            // Best-effort: if the close call itself fails we still try to
            // redial below; libp2p will reuse an existing connection if one
            // somehow survived.
          }
        }
        // Brief delay so the remote side has time to release the prior hop
        // reservation slot before we ask for a new one.
        const delayMs = RELAY_REDIAL_DELAY_MS + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, delayMs));
        try {
          await node.dial(addr);
          console.log(`[${ts()}] Relay watchdog: redialed ${short(relayPidStr)} for fresh reservation`);
        } catch (err: any) {
          console.log(`[${ts()}] Relay watchdog: reservation-redial failed for ${short(relayPidStr)}: ${err.message}`);
        }
        continue;
      }

      // Transport is down — classic disconnect path.
      allHealthy = false;
      console.log(`[${ts()}] Relay watchdog: ${short(relayPidStr)} disconnected, redialing…`);
      const delayMs = RELAY_REDIAL_DELAY_MS + Math.floor(Math.random() * 1000);
      await new Promise(r => setTimeout(r, delayMs));
      try {
        await node.dial(addr);
        console.log(`[${ts()}] Relay watchdog: reconnected to ${short(relayPidStr)}`);
      } catch (err: any) {
        console.log(`[${ts()}] Relay watchdog: redial failed for ${short(relayPidStr)}: ${err.message}`);
      }
    }

    if (allHealthy) {
      this.relayWatchdogConsecutiveFailures = 0;
    } else {
      this.relayWatchdogConsecutiveFailures++;
      const nextDelay = Math.min(
        RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
        RELAY_WATCHDOG_MAX_INTERVAL_MS,
      );
      console.log(`[${ts()}] Relay watchdog: next check in ${Math.round(nextDelay / 1000)}s (attempt ${this.relayWatchdogConsecutiveFailures})`);
    }
  }

  /**
   * Wire up connection:open / connection:close listeners that track transport
   * type (direct vs relayed) and detect DCUtR upgrades from relay to direct.
   */
  private setupConnectionObservability(): void {
    const node = this.requireNode();
    const ts = () => new Date().toISOString();
    const short = (id: string) => id.slice(-8);

    node.addEventListener('connection:open', (evt) => {
      const conn = evt.detail;
      const pid = conn.remotePeer.toString();
      const addr = conn.remoteAddr?.toString() ?? 'unknown';
      const transport: ConnectionTransport = addr.includes('/p2p-circuit') ? 'relayed' : 'direct';
      const dir = conn.direction;

      if (transport === 'relayed') {
        this.relayedPeers.add(pid);
        console.log(
          `[${ts()}] Connection opened: ${short(pid)} transport=relayed ` +
          `dir=${dir} addr=${addr}`,
        );
      } else {
        const upgraded = this.relayedPeers.has(pid);
        if (upgraded) {
          this.relayedPeers.delete(pid);
          console.log(
            `[${ts()}] DCUtR upgrade: ${short(pid)} relayed -> direct ` +
            `dir=${dir} addr=${addr}`,
          );
        } else {
          console.log(
            `[${ts()}] Connection opened: ${short(pid)} transport=direct ` +
            `dir=${dir} addr=${addr}`,
          );
        }
      }
    });

    node.addEventListener('connection:close', (evt) => {
      const conn = evt.detail;
      const pid = conn.remotePeer.toString();
      const addr = conn.remoteAddr?.toString() ?? 'unknown';
      const transport: ConnectionTransport = addr.includes('/p2p-circuit') ? 'relayed' : 'direct';
      const durationMs = conn.timeline.close
        ? conn.timeline.close - conn.timeline.open
        : '?';

      // If this was the last connection to the peer, clean up tracking state.
      const remaining = node.getConnections(conn.remotePeer);
      if (remaining.length === 0) {
        this.relayedPeers.delete(pid);
      }

      console.log(
        `[${ts()}] Connection closed: ${short(pid)} transport=${transport} ` +
        `duration=${durationMs}ms addr=${addr}`,
      );
    });

    node.addEventListener('peer:disconnect', (evt) => {
      const pid = evt.detail.toString();
      this.relayedPeers.delete(pid);
      console.log(`[${ts()}] Peer disconnected: ${short(pid)}`);
    });
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    if (this.relayWatchdogTimer) {
      clearTimeout(this.relayWatchdogTimer);
      this.relayWatchdogTimer = null;
    }
    this.relayTargets = [];
    this.relayWatchdogConsecutiveFailures = 0;
    this.relayReservationRedialAt.clear();
    this.relayedPeers.clear();
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
