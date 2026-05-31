/**
 * RC11 / PR3: typed error surface for the V10 ACK provider.
 *
 * The ACK provider has two structurally distinct failure modes that the
 * dzudza incident (Sun 20:42 UTC, 0 KCs minted, 82 quads stored as
 * "tentative") collapsed into a single opaque "V10 ACK collection failed"
 * string. Operators staring at the daemon log could not tell whether:
 *
 *   - the publisher couldn't even READ the chain pre-flight values
 *     (chainId / KAV10 address / minimumRequiredSignatures) because the
 *     RPC endpoint was rate-limited / unreachable / 5xx-ing, OR
 *
 *   - the publisher had the chain values, dialled N cores, and got
 *     back fewer than the quorum needed (peer ACK collection actually
 *     failed),
 *
 * which are completely different operational issues (RPC config vs.
 * network-topology / peer reachability). PR3 promotes them to distinct
 * subclasses so:
 *
 *   1. `dkg-publisher.ts` catch sites can log the typed cause verbatim
 *      instead of squashing it through `String(err)`,
 *
 *   2. PR5's per-peer telemetry can attach the dial outcomes
 *      structurally to `QuorumUnmetError`,
 *
 *   3. callers (DKGAgent / daemon publish route) can route on
 *      `err instanceof RpcPreconditionError` to surface a 503 vs a
 *      QuorumUnmet 409 (telemetry follow-up).
 *
 * Both subclasses preserve the underlying cause (`Error.cause`) so the
 * original stack survives intact — the typed shell is purely an
 * additional discriminator on top.
 */

/** Common base — lets callers do `err instanceof ACKProviderError` for the broad bucket. */
export abstract class ACKProviderError extends Error {
  override readonly name: string;
  constructor(name: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = name;
    // V8 / Node — keep the constructor frame out of the stack so the
    // first line of `.stack` is the actual throw site.
    if (typeof (Error as typeof Error & { captureStackTrace?: unknown }).captureStackTrace === 'function') {
      (Error as unknown as { captureStackTrace: (target: object, ctor: unknown) => void }).captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Raised when the V10 ACK provider cannot read the chain pre-flight
 * values it needs to build the ACK digest. Includes the RPC URL and the
 * upstream provider error code (e.g. `-32016 over rate limit` against
 * the public Base Sepolia RPC) when available so an operator can tell
 * "switch to a private RPC" from "the chain is down".
 *
 * The three methods that contribute to this surface live on
 * `ChainAdapter`:
 *   - `getEvmChainId()` (signs into the H5 ACK digest prefix)
 *   - `getKnowledgeAssetsLifecycleAddress()` (signs into the H5 prefix)
 *   - `getMinimumRequiredSignatures()` (decides the quorum the
 *     collector must reach)
 *
 * Any one of these failing puts the whole ACK collection on this typed
 * path. `evm-adapter.ts` caches all three on first successful read
 * (PR3) so the steady-state cost is zero RPC per publish.
 */
export class RpcPreconditionError extends ACKProviderError {
  /** Which adapter method failed. */
  readonly method: string;
  /** RPC URL the failing call hit (best-effort — adapter may not expose it). */
  readonly url?: string;
  /** Upstream provider error code (JSON-RPC error.code) when surfaced by the provider. */
  readonly upstream?: string | number;

  constructor(opts: {
    method: string;
    message: string;
    url?: string;
    upstream?: string | number;
    cause?: unknown;
  }) {
    super('RpcPreconditionError', formatRpcPreconditionMessage(opts), { cause: opts.cause });
    this.method = opts.method;
    if (opts.url !== undefined) this.url = opts.url;
    if (opts.upstream !== undefined) this.upstream = opts.upstream;
  }
}

function formatRpcPreconditionMessage(opts: {
  method: string;
  message: string;
  url?: string;
  upstream?: string | number;
}): string {
  const parts: string[] = [`${opts.method}: ${opts.message}`];
  if (opts.url) parts.push(`url=${opts.url}`);
  if (opts.upstream !== undefined) parts.push(`upstream=${opts.upstream}`);
  return `RpcPreconditionError(${parts.join(', ')})`;
}

/**
 * Per-peer outcome attached to `QuorumUnmetError` so PR5's telemetry
 * surface can render an actionable "why didn't this publish reach
 * quorum" breakdown. All fields are best-effort — collectors that
 * cannot determine a field leave it `undefined`.
 */
export interface PeerOutcome {
  /** libp2p peer id this outcome belongs to. */
  peerId: string;
  /** `true` when the publisher's transport could reach the peer at all. */
  dialOk?: boolean;
  /** `true` when the peer advertised the StorageACK protocol. */
  protocolSupported?: boolean;
  /** `true` when the peer's host-mode bookkeeping says it had subscribed to the CG SWM at ACK time. */
  swmHostModeAdvertised?: boolean;
  /** Human-readable terminal reason (`TRANSPORT_ERROR`, `STORAGE_ACK_DECLINE:NO_DATA_IN_SWM`, etc.). */
  reason?: string;
}

/**
 * Raised when the V10 ACK provider dialled N cores and collected
 * fewer than the on-chain `minimumRequiredSignatures`. Includes the
 * counts and (when the collector supplies it) per-peer outcomes so
 * an operator can distinguish:
 *
 *   - "no rc.10 cores connected" (every peer `dialOk: false`)
 *   - "cores connected but none subscribed to the CG"
 *     (`protocolSupported: true, swmHostModeAdvertised: false`)
 *   - "subscribed cores actively declined"
 *     (`reason: STORAGE_ACK_DECLINE:*`)
 *
 * The legacy `ACKCollector` (`packages/publisher/src/ack-collector.ts`)
 * surfaces aggregated reason strings as a fallback — PR5 will plumb
 * the structured per-peer shape end-to-end.
 */
export class QuorumUnmetError extends ACKProviderError {
  readonly collected: number;
  readonly required: number;
  readonly dialled: number;
  readonly peerOutcomes: PeerOutcome[];
  /** Optional legacy `storage_ack_insufficient: ...` text the ACK collector embedded for log-grep continuity. */
  readonly legacyMessage?: string;

  constructor(opts: {
    collected: number;
    required: number;
    dialled: number;
    peerOutcomes?: PeerOutcome[];
    /**
     * When provided, embedded verbatim at the head of `.message` so
     * pre-PR3 log greps and tests that match
     * `storage_ack_insufficient` / `storage_ack_timeout` /
     * `ACK collection failed:` keep working. The typed `QuorumUnmetError`
     * tag remains visible afterwards for new diagnostics.
     */
    legacyMessage?: string;
    cause?: unknown;
  }) {
    super('QuorumUnmetError', formatQuorumUnmetMessage(opts), { cause: opts.cause });
    this.collected = opts.collected;
    this.required = opts.required;
    this.dialled = opts.dialled;
    this.peerOutcomes = opts.peerOutcomes ?? [];
    if (opts.legacyMessage !== undefined) this.legacyMessage = opts.legacyMessage;
  }
}

function formatQuorumUnmetMessage(opts: {
  collected: number;
  required: number;
  dialled: number;
  peerOutcomes?: PeerOutcome[];
  legacyMessage?: string;
}): string {
  const outcomes = (opts.peerOutcomes ?? [])
    .map((p) => {
      const flags = [
        p.dialOk === false ? 'dial=fail' : p.dialOk === true ? 'dial=ok' : undefined,
        p.protocolSupported === false ? 'proto=unsupported' : undefined,
        p.swmHostModeAdvertised === false ? 'host-mode=off' : undefined,
        p.reason ? `reason=${p.reason}` : undefined,
      ].filter(Boolean);
      const tail = flags.length > 0 ? ` (${flags.join(', ')})` : '';
      return `${p.peerId.slice(-8)}${tail}`;
    })
    .join('; ');
  const summary = `QuorumUnmetError(collected=${opts.collected}/${opts.required}, dialled=${opts.dialled}`;
  const typed = outcomes ? `${summary}, peers=[${outcomes}])` : `${summary})`;
  return opts.legacyMessage ? `${opts.legacyMessage} [${typed}]` : typed;
}

/**
 * Best-effort heuristic to recognise a `RpcPreconditionError` shape in
 * a raw thrown value (e.g. an ethers JSON-RPC error or a plain Error
 * whose message mentions the adapter method name). Used by the agent's
 * V10 ACK provider wrapper to upgrade the legacy untyped throw into
 * the typed surface without forcing every adapter to know about
 * `RpcPreconditionError` directly.
 */
const RPC_PRECONDITION_METHODS = new Set([
  'getEvmChainId',
  'getKnowledgeAssetsLifecycleAddress',
  'getMinimumRequiredSignatures',
]);

export interface UnwrapRpcOptions {
  url?: string;
}

export function wrapAsRpcPreconditionIfApplicable(
  err: unknown,
  method: string,
  opts?: UnwrapRpcOptions,
): RpcPreconditionError {
  if (err instanceof RpcPreconditionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const upstream = extractUpstreamCode(err);
  return new RpcPreconditionError({
    method,
    message,
    ...(opts?.url !== undefined ? { url: opts.url } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
    cause: err,
  });
}

function extractUpstreamCode(err: unknown): string | number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const anyErr = err as Record<string, unknown>;
  // Common ethers / json-rpc shapes: `err.code`, `err.error.code`, `err.info.error.code`.
  for (const path of [['code'], ['error', 'code'], ['info', 'error', 'code']] as const) {
    let cur: unknown = anyErr;
    for (const seg of path) {
      if (cur === null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur === 'string' || typeof cur === 'number') return cur;
  }
  return undefined;
}

export function isACKProviderError(err: unknown): err is ACKProviderError {
  return err instanceof ACKProviderError;
}

export function isRpcPreconditionError(err: unknown): err is RpcPreconditionError {
  return err instanceof RpcPreconditionError;
}

export function isQuorumUnmetError(err: unknown): err is QuorumUnmetError {
  return err instanceof QuorumUnmetError;
}

/** Exposed for unit tests + future PR5 integration. */
export const _internal_RPC_PRECONDITION_METHODS = RPC_PRECONDITION_METHODS;
