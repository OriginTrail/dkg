/**
 * OT-RFC-27 marketplace executors — the seller-side pluggable "do the work"
 * seam. An executor turns an authorized serve payload into result bytes plus
 * the deterministic unit count both sides meter with. Three executors ship:
 *
 *  - `createStubInferenceExecutor()` — deterministic echo/transform used in
 *    tests (`countTokens` = ceil(utf8/4), the placeholder schedule).
 *  - `createQueryExecutor(queryFn, opts)` — bridges to the node's local SPARQL
 *    entry point (injected, so the service stays agent-agnostic), metered by
 *    the content-addressed static query cost schedule (`QUERY_COST_SCHEDULE_V1`).
 *  - `createChatConnectorExecutor(...)` (`chat-executor.ts`) — real LLM
 *    upstreams metered with a pinned tokenizer.
 *
 * Executors fail CLOSED on the authorization's `maxUnits` ceiling: anything
 * that cannot fit throws `MarketplaceExecutionError('OVER_MAX_UNITS')` so the
 * seller never signs a receipt the contract would reject.
 */
import {
  DEFAULT_QUERY_GUARDS,
  MAX_SERVE_RESULT_BYTES,
  QUERY_COST_SCHEDULE_V1,
  QUERY_COST_SCHEDULE_V1_DIGEST,
  QUERY_RESULT_SCHEMA,
  assertQueryWithinLimit,
  countResultRows,
  countTokens,
  queryDeliveryUnits,
  queryRowCap,
  type QueryAbortReason,
  type QueryGuards,
  type QueryServeResult,
} from '@origintrail-official/dkg-marketplace';

export type MarketplaceExecutorKind = 'inference' | 'query';

export type MarketplaceExecutionErrorCode =
  | 'BAD_PAYLOAD'
  | 'OVER_MAX_UNITS'
  | 'EXECUTION_FAILED'
  | 'METERING_OVERRUN'
  | 'TOOLS_UNSUPPORTED'
  | 'MODEL_MISMATCH'
  | 'CONTEXT_EXCEEDED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_AUTH'
  | 'BUYER_NOT_ALLOWED'
  | 'CONNECTOR_UNAVAILABLE';

/**
 * Refusal codes that are the CALLER's fault: they never count as seller
 * delivery failures in the buyer's delivery history.
 */
export const MARKETPLACE_CALLER_FAULT_CODES: ReadonlySet<string> = new Set([
  'BAD_PAYLOAD',
  'MODEL_MISMATCH',
  'TOOLS_UNSUPPORTED',
  'CONTEXT_EXCEEDED',
  'OVER_MAX_UNITS',
  'UNDERFUNDED',
  'BUYER_NOT_ALLOWED',
]);

export class MarketplaceExecutionError extends Error {
  readonly code: MarketplaceExecutionErrorCode;

  constructor(code: MarketplaceExecutionErrorCode, message: string) {
    super(message);
    this.name = 'MarketplaceExecutionError';
    this.code = code;
  }
}

export interface MarketplaceExecution {
  /** Raw result bytes (JSON); hashed into the receipt's `resultCommitment`. */
  resultBytes: Uint8Array;
  /** Units actually served — ALWAYS `0 < unitsServed <= maxUnits`. */
  unitsServed: bigint;
}

export interface MarketplaceExecutor {
  readonly kind: MarketplaceExecutorKind;
  execute(payload: Uint8Array, bounds: { maxUnits: bigint }): Promise<MarketplaceExecution>;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function parseJsonPayload(payload: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(payload));
  } catch (error) {
    throw new MarketplaceExecutionError(
      'BAD_PAYLOAD',
      `payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MarketplaceExecutionError('BAD_PAYLOAD', 'payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Deterministic inference stub: payload `{ prompt }` → result
 * `{ output, truncated }` where `output` echoes the prompt. Metering is
 * prompt tokens + output tokens (`countTokens` = ceil(utf8/4), the shared
 * prototype schedule); the output is truncated so the total fits `maxUnits`
 * and the call fails closed when the prompt alone exceeds the ceiling.
 */
export function createStubInferenceExecutor(): MarketplaceExecutor {
  return {
    kind: 'inference',
    async execute(payload, bounds) {
      const { prompt } = parseJsonPayload(payload);
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new MarketplaceExecutionError('BAD_PAYLOAD', 'inference payload needs a non-empty string `prompt`');
      }
      const promptTokens = countTokens(prompt);
      if (promptTokens > bounds.maxUnits) {
        throw new MarketplaceExecutionError(
          'OVER_MAX_UNITS',
          `prompt alone meters ${promptTokens} tokens, over the authorized maxUnits ${bounds.maxUnits}`,
        );
      }
      // Truncate the echo so prompt + output fits the authorization. The
      // token schedule is ceil(utf8/4) so trimming characters monotonically
      // shrinks the count; an empty output (prompt exactly at the ceiling)
      // is still a valid, positively-metered serve.
      const outputBudget = bounds.maxUnits - promptTokens;
      let output = prompt;
      let truncated = false;
      while (output.length > 0 && countTokens(output) > outputBudget) {
        const overshootChars = Number(countTokens(output) - outputBudget) * 4;
        output = output.slice(0, Math.max(0, output.length - Math.max(1, overshootChars)));
        truncated = true;
      }
      const unitsServed = promptTokens + countTokens(output);
      return {
        resultBytes: textEncoder.encode(JSON.stringify({ output, truncated })),
        unitsServed,
      };
    },
  };
}

/** The injected local-SPARQL entry point (the agent's `query()`), guarded by a timeout + abort signal. */
export type MarketplaceQueryFn = (
  sparql: string,
  opts: { timeoutMs: number; signal: AbortSignal },
) => Promise<{
  /** Informational only — rows are always `countResultRows(result)` of the served value. */
  rowCount?: number;
  /** JSON-serializable query result returned to the buyer. */
  result: unknown;
}>;

export interface QueryExecutorOptions {
  guards?: Partial<QueryGuards>;
  /** Result-size cap checked before a receipt exists; default `MAX_SERVE_RESULT_BYTES`. */
  maxResultBytes?: number;
}

class QueryGuardTimeout extends Error {}

/**
 * Local-SPARQL executor under the static cost schedule: payload `{ sparql }`
 * → `{ schema: 'sparql-result/v1', result, rowCount, metering }`.
 *
 *  - Admission is charged up front: `queryRowCap` refuses `OVER_MAX_UNITS`
 *    before anything runs when `maxUnits` cannot cover it.
 *  - Delivery is `ceil(rows / 100)`, rows = `countResultRows` of the exact
 *    value serialized (bindings + quads), never the query fn's own count.
 *  - A guard abort (timeout, rows over the row cap, or a result too large to
 *    deliver) still owes admission: `result: null`, `servedUnits = admission`.
 *  - A backend failure is `EXECUTION_FAILED` (no receipt).
 */
export function createQueryExecutor(queryFn: MarketplaceQueryFn, opts: QueryExecutorOptions = {}): MarketplaceExecutor {
  const guards: QueryGuards = { ...DEFAULT_QUERY_GUARDS, ...opts.guards };
  const maxResultBytes = opts.maxResultBytes ?? MAX_SERVE_RESULT_BYTES;
  return {
    kind: 'query',
    async execute(payload, bounds) {
      const { sparql } = parseJsonPayload(payload);
      if (typeof sparql !== 'string' || sparql.length === 0) {
        throw new MarketplaceExecutionError('BAD_PAYLOAD', 'query payload needs a non-empty string `sparql`');
      }
      let admission: ReturnType<typeof queryRowCap>;
      try {
        assertQueryWithinLimit(sparql);
        admission = queryRowCap(sparql, bounds.maxUnits, guards.maxRows);
      } catch (error) {
        throw new MarketplaceExecutionError('BAD_PAYLOAD', (error as Error).message);
      }
      if (!admission.admit) {
        throw new MarketplaceExecutionError('OVER_MAX_UNITS', `query admission alone exceeds the authorized maxUnits ${bounds.maxUnits}`);
      }
      const { admissionUnits, rowCap } = admission;
      const aborted = (reason: QueryAbortReason): MarketplaceExecution => encodeQueryResult({
        schema: QUERY_RESULT_SCHEMA,
        result: null,
        rowCount: 0,
        metering: {
          scheduleDigest: QUERY_COST_SCHEDULE_V1_DIGEST,
          admissionUnits: Number(admissionUnits),
          deliveryUnits: 0,
          servedUnits: Number(admissionUnits),
          rowCount: 0,
          aborted: { reason },
        },
      }, admissionUnits);

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new QueryGuardTimeout('query guard timeout'));
          reject(new QueryGuardTimeout('query guard timeout'));
        }, guards.timeoutMs);
        timer.unref?.();
      });
      let outcome: Awaited<ReturnType<MarketplaceQueryFn>>;
      try {
        outcome = await Promise.race([queryFn(sparql, { timeoutMs: guards.timeoutMs, signal: controller.signal }), deadline]);
      } catch (error) {
        if (error instanceof QueryGuardTimeout || controller.signal.aborted) return aborted('timeout');
        throw new MarketplaceExecutionError(
          'EXECUTION_FAILED',
          `local query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      const rows = countResultRows(outcome.result);
      if (BigInt(rows) > rowCap) return aborted('row-cap');
      const deliveryUnits = queryDeliveryUnits(rows, QUERY_COST_SCHEDULE_V1);
      const servedUnits = admissionUnits + deliveryUnits;
      const delivered = encodeQueryResult({
        schema: QUERY_RESULT_SCHEMA,
        result: outcome.result,
        rowCount: rows,
        metering: {
          scheduleDigest: QUERY_COST_SCHEDULE_V1_DIGEST,
          admissionUnits: Number(admissionUnits),
          deliveryUnits: Number(deliveryUnits),
          servedUnits: Number(servedUnits),
          rowCount: rows,
        },
      }, servedUnits);
      return delivered.resultBytes.byteLength > maxResultBytes ? aborted('size-cap') : delivered;
    },
  };
}

function encodeQueryResult(result: QueryServeResult, unitsServed: bigint): MarketplaceExecution {
  return { resultBytes: textEncoder.encode(JSON.stringify(result)), unitsServed };
}

/** The pinned query cost schedule every `local-query` offer publishes. */
export const QUERY_OFFER_COST_PIN = Object.freeze({
  schedule: QUERY_COST_SCHEDULE_V1.version,
  digest: QUERY_COST_SCHEDULE_V1_DIGEST,
});
