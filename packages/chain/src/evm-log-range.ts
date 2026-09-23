// SPDX-License-Identifier: Apache-2.0

/**
 * eth_getLogs range limits: one classifier and one provider-scoped adaptive
 * reader, shared by every log scanner in the adapter.
 *
 * Providers refuse an eth_getLogs range for two different reasons, and only
 * one of them is fixed by asking for less:
 *
 *  - SPAN caps. The requested block span is wider than the provider serves in
 *    one request (`eth_getLogs is limited to a 2,000 range`, `block range too
 *    large`). Narrower requests over the SAME blocks succeed, so the reader
 *    splits, and remembers the cap for that provider so later reads start at
 *    it instead of failing first.
 *  - DEPTH limits. The blocks are older than the provider serves at all:
 *    archive gating, pruned history, or a plan tier (`Archive requests require
 *    a personal token`; `ranges over 10000 blocks are not supported on free
 *    plan`, which a 2,000-block request receives too). A narrower request over
 *    the same blocks fails the same way, so splitting would only multiply
 *    requests. The reader never splits these, never records a span cap for
 *    them (recent-block reads on that provider are unaffected), and throws a
 *    failover-eligible {@link EvmLogRangeUnavailableError} so the caller's
 *    provider loop moves on to the next endpoint.
 */

import { collectEvmErrorText } from './evm-error-text.js';
import { rpcHost } from './rpc-failover-log.js';

/** What a provider's eth_getLogs refusal says about the requested range. */
export type EvmLogRangeLimit =
  /** The span is too wide. `maxBlocks` is set when the provider states its cap. */
  | Readonly<{ kind: 'span'; maxBlocks?: number }>
  /** The blocks are too old for this provider (archive, pruning or plan tier). */
  | Readonly<{ kind: 'depth' }>;

/**
 * Most physical eth_getLogs requests one adaptive read may issue against one
 * provider, failed attempts included. A 9,000-block event-lane page costs five
 * requests on a 2,000-block cap, so this admits caps down to roughly 300
 * blocks for the widest page any reader asks for; a provider whose cap is
 * smaller than that is treated as unable to serve the range and the caller
 * fails over instead of issuing hundreds of tiny requests.
 */
export const EVM_LOG_RANGE_MAX_REQUESTS_PER_READ = 32;

/**
 * A provider cannot serve an eth_getLogs range: a depth/archive/plan limit, or
 * a span cap too small to cover the range within the per-read request budget.
 *
 * Always endpoint-failover eligible (`classifyRpcRetryDisposition` recognises
 * it by type): another configured provider may well serve the same range.
 */
export class EvmLogRangeUnavailableError extends Error {
  readonly code = 'EVM_LOG_RANGE_UNAVAILABLE';

  constructor(
    message: string,
    readonly limit: EvmLogRangeLimit,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EvmLogRangeUnavailableError';
  }
}

/** A block count as providers print it: `2000`, `2,000`, `10_000` or `2K`. */
const BLOCK_COUNT = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d+)(?:\s?(k)\b)?`;

/** Span phrasings that state the cap. The first capture group is the count. */
const STATED_SPAN_CAP_PATTERNS: readonly RegExp[] = [
  // mainnet.base.org and QuickNode: "eth_getLogs is limited to a 2,000 range";
  // others: "limited to 50 blocks", "limited to a 1000 block range".
  new RegExp(String.raw`limited to (?:an? )?${BLOCK_COUNT} (?:blocks?(?: range)?|range)`),
  // "Block range too large: maximum allowed is 50 blocks".
  new RegExp(String.raw`maximum (?:allowed )?is ${BLOCK_COUNT} blocks?`),
  // BSC/Erigon style: "exceed maximum block range: 5000".
  new RegExp(String.raw`exceeds? (?:the )?(?:max(?:imum)? )?(?:allowed )?block range(?: limit)?(?: of)?:? ${BLOCK_COUNT}`),
  // dRPC wording: "ranges over 10000 blocks are not supported".
  new RegExp(String.raw`ranges? over ${BLOCK_COUNT} blocks? (?:are|is) not supported`),
  // Alchemy: "... eth_getLogs requests with up to a 2K block range ...".
  new RegExp(String.raw`up to (?:an? )?${BLOCK_COUNT} block range`),
  // "requested too many blocks from 0 to 20000, maximum is set to 2048".
  new RegExp(String.raw`too many blocks from \d+ to \d+, maximum is set to ${BLOCK_COUNT}`),
  // "max block range is 800", "maximum block range: 5000", "block range limit of 1000".
  new RegExp(String.raw`(?:max(?:imum)? (?:block )?range|block range limit)(?: size)?(?: is| of)?:? ${BLOCK_COUNT}`),
];

/** Span phrasings that name no cap: the reader halves until one succeeds. */
const UNSTATED_SPAN_PATTERN = new RegExp([
  String.raw`range (?:is )?too (?:large|wide|big)`,
  String.raw`exceeds? (?:the )?(?:max(?:imum)? )?(?:allowed )?block range`,
  String.raw`block range (?:limit )?exceeded`,
  String.raw`too many blocks`,
  // Result-size limits (Infura, Alchemy): a narrower span returns fewer logs.
  String.raw`query returned more than \d[\d,]* results`,
  String.raw`log response size exceeded`,
].join('|'));

/** Blocks the provider does not serve at any span. */
const DEPTH_PATTERN = new RegExp([
  String.raw`\barchive\b`,
  String.raw`\bpruned\b`,
  String.raw`\bhistory (?:is |has been )?(?:not available|unavailable|expired)`,
  String.raw`\bhistorical (?:data|logs?|blocks?|state) (?:is |are )?(?:not available|unavailable|not supported)`,
  String.raw`\bonly (?:the )?(?:last|latest|most recent) \d[\d,]* blocks?`,
].join('|'));

/**
 * Plan-tier gating. It turns a range refusal into a depth limit, but on its
 * own it is not a range limit at all: dRPC also says "Request timeout on the
 * free plan, please upgrade to paid plan" for a plain timeout.
 */
const PLAN_PATTERN = new RegExp([
  String.raw`\b(?:free|basic|starter|developer|discover|trial|hobby)[ -](?:plan|tier)\b`,
  String.raw`\bupgrade (?:your |to (?:an? |the )?)?(?:plan|paid|tier|payg|premium)`,
  String.raw`\bpaid (?:plan|tier)\b`,
  String.raw`\bpersonal token\b`,
].join('|'));

/** Any URL in error text (the request URL ethers embeds, a provider's sign-up link). */
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/g;

function parseBlockCount(digits: string, thousands: string | undefined): number | undefined {
  const value = Number(digits.replace(/[,_]/g, '')) * (thousands === undefined ? 1 : 1_000);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function matchSpanLimit(text: string): { maxBlocks?: number } | undefined {
  for (const pattern of STATED_SPAN_CAP_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const maxBlocks = parseBlockCount(match[1]!, match[2]);
    return maxBlocks === undefined ? {} : { maxBlocks };
  }
  return UNSTATED_SPAN_PATTERN.test(text) ? {} : undefined;
}

/**
 * Classify a provider's eth_getLogs refusal, or return `undefined` when the
 * error is not a range limit at all (timeouts, 5xx, network failures).
 *
 * `requestedBlocks` is the inclusive span (`toBlock - fromBlock + 1`) of the
 * refused request. With it, a stated cap is checked against what was actually
 * asked: a provider that refuses a request strictly BELOW its own stated cap
 * is not enforcing that span (dRPC's free plan refuses a 2,000-block request
 * with "ranges over 10000 blocks"), so the refusal is a depth limit. A refusal
 * AT the stated cap reads the cap as exclusive, and the cap becomes one less.
 */
export function classifyEvmLogRangeLimitError(
  err: unknown,
  requestedBlocks?: number,
): EvmLogRangeLimit | undefined {
  // URLs are dropped first: ethers embeds the request URL in every HTTP-level
  // error message, and an operator endpoint such as `base-archive.example.org`
  // must not turn a span refusal into a depth limit.
  const text = collectEvmErrorText(err).replace(URL_PATTERN, ' ');
  if (DEPTH_PATTERN.test(text)) return { kind: 'depth' };
  const span = matchSpanLimit(text);
  if (span === undefined) return undefined;
  if (PLAN_PATTERN.test(text)) return { kind: 'depth' };
  const stated = span.maxBlocks;
  if (stated === undefined || requestedBlocks === undefined) {
    return stated === undefined ? { kind: 'span' } : { kind: 'span', maxBlocks: stated };
  }
  if (requestedBlocks < stated) return { kind: 'depth' };
  const maxBlocks = Math.min(stated, requestedBlocks - 1);
  return maxBlocks >= 1 ? { kind: 'span', maxBlocks } : { kind: 'span' };
}

/**
 * Learned span caps, keyed by the provider object every reader of that
 * endpoint shares. Weakly held: a rebuilt provider pool starts fresh and
 * relearns with one refused request. Only span caps live here; a depth limit
 * never narrows how a provider is asked for recent blocks.
 */
const learnedSpanCaps = new WeakMap<object, number>();

/** The span cap learned for `provider`, if any (observability and tests). */
export function learnedEvmLogSpanCap(provider: object): number | undefined {
  return learnedSpanCaps.get(provider);
}

function providerHost(provider: object | undefined): string {
  try {
    const connection = (provider as { _getConnection?: () => { url?: unknown } } | undefined)
      ?._getConnection?.();
    return typeof connection?.url === 'string' ? rpcHost(connection.url) : 'the provider';
  } catch {
    return 'the provider';
  }
}

/**
 * The provider's own words: the JSON-RPC `{ code, message }` ethers nests
 * under `error`, or the body of an HTTP-level refusal. Falls back to the
 * error's own message.
 */
function providerMessage(err: unknown): string {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (value === null || typeof value !== 'object' || depth > 5 || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string' && typeof record.code === 'number') return record.message;
    if (typeof record.responseBody === 'string') {
      try {
        const body = JSON.parse(record.responseBody) as { error?: { message?: unknown } };
        if (typeof body.error?.message === 'string') return body.error.message;
      } catch { /* not JSON: keep looking */ }
    }
    for (const key of ['error', 'info', 'cause']) {
      const found = visit(record[key], depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = visit(err, 0)
    ?? (err instanceof Error ? err.message : collectEvmErrorText(err));
  return found.length > 300 ? `${found.slice(0, 300)}…` : found;
}

/**
 * Identity of a log row, when the row carries one: every positional field it
 * has, so only a row that is the same log twice ever collides.
 */
function logIdentity(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const log = row as {
    blockHash?: unknown;
    blockNumber?: unknown;
    transactionHash?: unknown;
    index?: unknown;
    logIndex?: unknown;
  };
  const index = typeof log.index === 'number'
    ? log.index
    : typeof log.logIndex === 'number' ? log.logIndex : undefined;
  const blockNumber = typeof log.blockNumber === 'number' ? log.blockNumber : undefined;
  const blockHash = typeof log.blockHash === 'string' ? log.blockHash.toLowerCase() : undefined;
  if (index === undefined || (blockNumber === undefined && blockHash === undefined)) return undefined;
  const transactionHash = typeof log.transactionHash === 'string'
    ? log.transactionHash.toLowerCase()
    : '';
  return `${blockNumber ?? ''}:${blockHash ?? ''}:${transactionHash}:${index}`;
}

export interface AdaptiveEvmLogRangeParams<T> {
  /** One physical eth_getLogs over an inclusive range. Give it its own deadline. */
  read: (fromBlock: number, toBlock: number) => Promise<readonly T[]>;
  fromBlock: number;
  toBlock: number;
  signal?: AbortSignal;
  /**
   * The provider `read` goes to. Its learned span cap is shared with every
   * other reader of the same provider, so a cap learned by one scanner is
   * where the next one starts. Without it, a cap lasts for this call only.
   */
  provider?: object;
  /** Defaults to {@link EVM_LOG_RANGE_MAX_REQUESTS_PER_READ}. */
  maxRequests?: number;
}

/**
 * Read one inclusive eth_getLogs range from ONE provider, fitting it to the
 * provider's span cap.
 *
 * - A known cap splits the range before anything is sent.
 * - A span refusal records the cap (the stated one, else half the refused
 *   span) and retries the refused range at it.
 * - A depth refusal is never split: it becomes a failover-eligible
 *   {@link EvmLogRangeUnavailableError} after a single request.
 * - Anything else propagates unchanged.
 *
 * Requests are sequential, so a compatibility retry never becomes a burst, and
 * bounded by `maxRequests`: a range the cap cannot cover inside that budget is
 * refused up front rather than fetched one tiny span at a time. Rows come back
 * in chain order (ranges are read in ascending order), with any row a provider
 * returned twice dropped.
 */
export async function readAdaptiveEvmLogRange<T>(
  params: Readonly<AdaptiveEvmLogRangeParams<T>>,
): Promise<T[]> {
  const { read, fromBlock, toBlock, signal, provider } = params;
  const maxRequests = params.maxRequests ?? EVM_LOG_RANGE_MAX_REQUESTS_PER_READ;
  let localCap: number | undefined;
  const currentCap = (): number | undefined => (
    provider === undefined ? localCap : learnedSpanCaps.get(provider)
  );
  const learn = (maxBlocks: number, stated: boolean): void => {
    const previous = currentCap();
    if (previous !== undefined && previous <= maxBlocks) return;
    if (provider === undefined) {
      localCap = maxBlocks;
      return;
    }
    learnedSpanCaps.set(provider, maxBlocks);
    // eslint-disable-next-line no-console
    console.log(
      `[chain] eth_getLogs span cap for ${providerHost(provider)}: ${maxBlocks} blocks `
        + `(${stated ? 'stated by the provider' : 'inferred from a refusal'}); `
        + 'later log reads start at this span',
    );
  };
  const unavailable = (
    detail: string,
    limit: EvmLogRangeLimit,
    cause?: unknown,
  ): EvmLogRangeUnavailableError => new EvmLogRangeUnavailableError(
    `eth_getLogs [${fromBlock}, ${toBlock}] ${detail} at ${providerHost(provider)}`
      + (cause === undefined ? '' : `: ${providerMessage(cause)}`),
    limit,
    cause === undefined ? undefined : { cause },
  );

  const pending: Array<[number, number]> = [[fromBlock, toBlock]];
  const rows: T[] = [];
  let requests = 0;
  let lastSpanRefusal: unknown;
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const cap = currentCap();
    // What the rest of the range costs at the current cap, checked BEFORE any
    // chunk list is built: a tiny cap over a wide range is refused, not
    // materialised.
    const needed = pending.reduce((sum, [lo, hi]) => (
      sum + (cap === undefined ? 1 : Math.max(1, Math.ceil((hi - lo + 1) / cap)))
    ), 0);
    if (requests + needed > maxRequests) {
      throw unavailable(
        `needs ${needed} more requests at a ${cap ?? 'full'}-block span (budget ${maxRequests})`,
        { kind: 'span', ...(cap === undefined ? {} : { maxBlocks: cap }) },
        lastSpanRefusal,
      );
    }
    const [lo, hi] = pending.shift()!;
    const span = hi - lo + 1;
    if (cap !== undefined && span > cap) {
      const chunks: Array<[number, number]> = [];
      for (let start = lo; start <= hi; start += cap) {
        chunks.push([start, Math.min(start + cap - 1, hi)]);
      }
      pending.unshift(...chunks);
      continue;
    }
    requests += 1;
    try {
      rows.push(...await read(lo, hi));
    } catch (err) {
      const limit = classifyEvmLogRangeLimitError(err, span);
      if (limit === undefined) throw err;
      if (limit.kind === 'depth') {
        throw unavailable('is beyond the history, archive or plan limit', limit, err);
      }
      if (span <= 1) throw unavailable('is refused even as a single block', limit, err);
      lastSpanRefusal = err;
      learn(limit.maxBlocks ?? Math.floor(span / 2), limit.maxBlocks !== undefined);
      pending.unshift([lo, hi]);
    }
  }

  const seen = new Set<string>();
  return rows.filter((row) => {
    const identity = logIdentity(row);
    if (identity === undefined) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
