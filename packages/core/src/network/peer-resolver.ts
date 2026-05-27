/**
 * PeerResolver — RFC 07 §3.
 *
 * Single in-process service every dial path consults before
 * `network.dialProtocol(peerId, …)`. Defined resolution order
 * (RFC 07 §3.1):
 *
 *   1. Active-connection cache — `network.getConnections(peerId)`.
 *      If a live conn exists the caller doesn't need any new addresses;
 *      we return its remote multiaddr and stop.
 *   2. DHT lookup — `network.findPeer(peerId)` with a per-step timeout.
 *   3. NetworkStateRegistry (RFC 04) — chain-anchored attestations.
 *      Stub in v1; populated when RFC 04 Phase 2 lands.
 *   4. Agent directory (agents-CG SPARQL) — preserves the chat-only
 *      `Messenger.ensureCircuitRelayAddress` behaviour we're replacing.
 *
 * Each step that finds addresses calls `network.addKnownAddresses` so
 * a subsequent `dialProtocol(peerId)` hits the transport's address
 * book without re-resolving. Returned list is deduplicated, ordered
 * freshest-first; callers should try in order and stop on first
 * successful dial. Never throws — every step's failure is caught and
 * the resolver falls through to the next.
 *
 * Note (Codex review feedback on PR #496): the previous draft included
 * a step 5 that emitted configured `bootstrapPeers` as candidate
 * addresses for the target peer. That was semantically wrong: a
 * bootstrap seed multiaddr names some seed peer (typically a
 * relay/curator), NOT the requested target. Returning it as a
 * candidate would either fail loudly (libp2p rejects the
 * `/p2p/<seed>`-vs-target peerId mismatch) or quietly mislead the
 * caller. Bootstrap is a libp2p-startup concern (`bootstrap({ list })`
 * peerDiscovery in `node.ts`), not a per-peer resolution concern;
 * step 5 has been removed.
 *
 * v1 implements `recordDialSuccess` / `recordDialFailure` /
 * `isHealthy` as stubs; address-health scoring is deferred to a
 * follow-up RFC.
 *
 * See also: `dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md`.
 */
import type { Network, NodeIdentity, Address } from './network.js';
import type { NetworkStateRegistry } from './network-state-registry.js';

/**
 * Minimal interface PeerResolver needs from the agents-CG. Defined in
 * core so PeerResolver doesn't import from `packages/agent`. The
 * existing `DiscoveryClient.findAgentByPeerId` shape is wrapped at
 * the construction site (see `dkg-agent.ts`).
 */
export interface AgentDirectoryLookup {
  /**
   * Returns the relay multiaddr advertised for `peerId` in the agents
   * context graph, or `null` if none is recorded. The resolver
   * appends `/p2p-circuit/p2p/<peerId>` to construct the dialable form.
   *
   * Codex review feedback on PR #496 round 4: takes an optional
   * `opts.signal` so an in-flight SPARQL query can be cancelled when
   * the resolver's outer signal aborts. Without this, `resolve()`
   * still checks `signal.aborted` BEFORE step 4 starts, but once
   * `findRelayForPeer` is running a timed-out call would block until
   * the SPARQL request finished naturally — defeating the end-to-end
   * deadline guarantee for `connectToPeerId({ timeoutMs })` callers.
   * Implementations that can't cancel (e.g. legacy DiscoveryClient)
   * may ignore the signal; the contract is best-effort.
   */
  findRelayForPeer(
    peerId: NodeIdentity,
    opts?: { signal?: AbortSignal },
  ): Promise<Address | null>;
}

export interface PeerResolverDeps {
  network: Network;
  registry: NetworkStateRegistry;
  agentDirectory: AgentDirectoryLookup;
  /** Optional logger; defaults to silent except for serious errors. */
  logger?: PeerResolverLogger;
}

export interface PeerResolverLogger {
  warn(msg: string): void;
  debug?(msg: string): void;
}

export interface ResolveOpts {
  /**
   * Skip the DHT lookup step. Used by callers that already know the
   * peer isn't in the routing table — e.g. cold-start `/api/connect`.
   */
  skipDht?: boolean;
  /**
   * Per-step timeout in ms; default 5_000. Caller is responsible for
   * the overall timeout budget across steps.
   */
  perStepTimeoutMs?: number;
  /** AbortSignal to cancel in-flight resolution. */
  signal?: AbortSignal;
}

const DEFAULT_PER_STEP_TIMEOUT_MS = 5_000;

const SILENT_LOGGER: PeerResolverLogger = {
  warn: () => undefined,
};

export class PeerResolver {
  private readonly network: Network;
  private readonly registry: NetworkStateRegistry;
  private readonly agentDirectory: AgentDirectoryLookup;
  private readonly logger: PeerResolverLogger;

  constructor(deps: PeerResolverDeps) {
    this.network = deps.network;
    this.registry = deps.registry;
    this.agentDirectory = deps.agentDirectory;
    this.logger = deps.logger ?? SILENT_LOGGER;
  }

  /**
   * Resolve `peerId` to an ordered list of multiaddrs to attempt.
   * See class doc for the resolution order; never throws — failures
   * in one step proceed to the next.
   *
   * Cancellation: if `opts.signal` is set, every step checks
   * `signal.aborted` before running. An already-aborted signal
   * returns whatever's been accumulated so far (or `[]` if nothing
   * yet). Per-step timeouts are layered ON TOP of the outer signal,
   * not subordinated to it: each step that has its own timeout
   * (DHT today; future: registry, agents-CG) composes a step-local
   * `AbortSignal.any([opts.signal, AbortSignal.timeout(perStep)])`
   * so neither input is silently ignored.
   */
  async resolve(peerId: NodeIdentity, opts?: ResolveOpts): Promise<Address[]> {
    const accumulated: Address[] = [];
    const seen = new Set<string>();
    const append = (addrs: Address[]): void => {
      for (const a of addrs) {
        if (a && !seen.has(a)) {
          seen.add(a);
          accumulated.push(a);
        }
      }
    };

    // Codex feedback PR #499 round 3: callers thread a single
    // AbortSignal through all steps, but only step 2 (DHT) was
    // honouring it. After timeout, registry + agents-CG still ran
    // unbounded, so connectToPeerId({ timeoutMs }) could overrun the
    // deadline by the registry+SPARQL latency. The check below makes
    // every step short-circuit when the signal is aborted.
    const aborted = (): boolean => opts?.signal?.aborted === true;

    // Codex feedback PR #496 round 3: `ResolveOpts.perStepTimeoutMs`
    // was documented as a real per-step cap, but when `opts.signal`
    // was also passed, `LibP2PNetwork.findPeer` honoured the signal
    // and silently dropped the timeout. Compose a step-local signal
    // that combines BOTH inputs so the per-step contract holds even
    // when the outer signal is longer-lived. Returns undefined when
    // no per-step cap and no outer signal are provided.
    const stepSignal = (perStepMs?: number): AbortSignal | undefined => {
      const withTimeout =
        perStepMs && perStepMs > 0 ? AbortSignal.timeout(perStepMs) : undefined;
      const outer = opts?.signal;
      if (withTimeout && outer) return AbortSignal.any([withTimeout, outer]);
      return withTimeout ?? outer;
    };

    // Step 1: active-connection cache. Sub-millisecond. If a live
    // connection exists the caller will reuse it via libp2p
    // connection-deduplication; no need to walk further.
    //
    // Codex feedback on PR #496: `getConnections(peerId)` calls
    // `peerIdFromString(peerId)` under the hood (via LibP2PNetwork)
    // and that throws on a malformed peerId. The class doc-comment
    // promises `resolve()` never throws, so wrap step 1 in the same
    // best-effort handler the later steps use. A bad peerId then
    // falls through, every later step fails identically, and the
    // resolver returns []. Callers downstream (e.g. ProtocolRouter
    // and connectToPeerId) get a clean DIAL_FAILED / PEER_NOT_FOUND
    // instead of an unhandled exception.
    if (aborted()) return accumulated;
    try {
      const live = this.network.getConnections(peerId);
      if (live.length > 0) {
        append(live.map((c) => c.remoteAddr.toString()));
        return accumulated;
      }
    } catch (err) {
      this.logger.debug?.(`live-conn lookup for ${peerId} failed: ${errMsg(err)}`);
    }

    // Codex review (PR #496 round 6, peer-resolver.ts:205): the
    // returned `accumulated` list is the resolver's contract surface —
    // callers (and ProtocolRouter via the migration in PR #497) treat
    // a non-empty return as proof the peerStore is primed. Steps 2-4
    // therefore MUST only append an address after `addKnownAddresses`
    // has actually written it. The previous order (append → merge)
    // would on a peerStore failure leave the caller thinking
    // resolution succeeded while the bare peer-id dial silently
    // missed every address.
    const primeAndAppend = async (
      addrs: Address[],
      stepLabel: string,
    ): Promise<void> => {
      if (addrs.length === 0) return;
      try {
        await this.network.addKnownAddresses(peerId, addrs);
        append(addrs);
      } catch (err) {
        this.logger.debug?.(
          `peerStore merge during ${stepLabel} for ${peerId} failed: ${errMsg(err)}`,
        );
      }
    };

    // Step 2: DHT lookup. Cheap for peers in the routing table;
    // expensive for cold peers. Skipped if caller asked or transport
    // doesn't support peer-routing.
    if (!opts?.skipDht && typeof this.network.findPeer === 'function') {
      if (aborted()) return accumulated;
      try {
        const perStepMs = opts?.perStepTimeoutMs ?? DEFAULT_PER_STEP_TIMEOUT_MS;
        const dhtAddrs = await this.network.findPeer(peerId, {
          signal: stepSignal(perStepMs),
          timeoutMs: perStepMs,
        });
        await primeAndAppend(dhtAddrs, 'DHT');
      } catch (err) {
        // DHT miss is the steady-state expectation for non-staked or
        // not-yet-discovered peers. Log at debug only.
        this.logger.debug?.(`DHT lookup for ${peerId} failed: ${errMsg(err)}`);
      }
    }

    // Step 3: NetworkStateRegistry (RFC 04). Stub in v1; the real
    // implementation can hit a database / mutex / SWM channel, so the
    // try/catch is the contract that protects callers from a transient
    // registry hiccup aborting the whole resolve() (and silently
    // skipping steps 4+).
    if (aborted()) return accumulated;
    try {
      const registryAddrs = await this.registry.lookup(peerId);
      await primeAndAppend(registryAddrs, 'registry');
    } catch (err) {
      this.logger.debug?.(`registry lookup for ${peerId} failed: ${errMsg(err)}`);
    }

    // Step 4: agent-directory SPARQL fallback. Replaces the chat-only
    // Messenger.ensureCircuitRelayAddress path. Pass `opts.signal`
    // through so an in-flight SPARQL query honours the outer deadline
    // (Codex review feedback on PR #496 round 4).
    if (aborted()) return accumulated;
    try {
      const relay = await this.agentDirectory.findRelayForPeer(peerId, {
        signal: opts?.signal,
      });
      if (relay) {
        const circuitAddr = `${relay}/p2p-circuit/p2p/${peerId}`;
        await primeAndAppend([circuitAddr], 'agents-CG');
      }
    } catch (err) {
      this.logger.debug?.(`agents-CG lookup for ${peerId} failed: ${errMsg(err)}`);
    }

    return accumulated;
  }

  recordDialSuccess(_addr: Address): void {
    // v1: no-op. Address-health scoring is a follow-up RFC.
  }

  recordDialFailure(addr: Address, reason: string): void {
    this.logger.debug?.(`dial failure for ${addr}: ${reason}`);
  }

  isHealthy(_addr: Address): boolean {
    return true;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
