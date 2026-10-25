/**
 * OT-RFC-27 marketplace executors — the seller-side pluggable "do the work"
 * seam. An executor turns an authorized serve payload into result bytes plus
 * the deterministic unit count both sides meter with (the shared schedules in
 * `@origintrail-official/dkg-marketplace`: `countTokens` for inference,
 * `queryUnits` for SPARQL). Two executors ship with the prototype:
 *
 *  - `createStubInferenceExecutor()` — deterministic echo/transform used on
 *    devnet and in tests; real LLM connectors are future node-side config.
 *  - `createQueryExecutor(queryFn)` — bridges to the node's local SPARQL
 *    entry point (injected, so the service stays agent-agnostic).
 *
 * Executors fail CLOSED on the authorization's `maxUnits` ceiling: inference
 * output is truncated to fit, and anything that cannot fit (a prompt alone
 * over the ceiling, a query result that cannot be shrunk) throws
 * `MarketplaceExecutionError('OVER_MAX_UNITS')` so the seller never signs a
 * receipt the contract would reject.
 */
import { countTokens, queryUnits } from '@origintrail-official/dkg-marketplace';

export type MarketplaceExecutorKind = 'inference' | 'query';

export type MarketplaceExecutionErrorCode =
  | 'BAD_PAYLOAD'
  | 'OVER_MAX_UNITS'
  | 'EXECUTION_FAILED';

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

function parseJsonPayload(payload: Uint8Array): Record<string, unknown> {
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

/** The injected local-SPARQL entry point (the agent's `query()`). */
export type MarketplaceQueryFn = (sparql: string) => Promise<{
  /** Result rows, for the `queryUnits` schedule. */
  rowCount: number;
  /** JSON-serializable query result returned to the buyer. */
  result: unknown;
}>;

/**
 * Local-SPARQL executor: payload `{ sparql }` → result `{ result }` from the
 * injected query entry point, metered with the shared
 * `queryUnits(sparql, rows)` schedule. A result over `maxUnits` cannot be
 * truncated (the row set IS the result) so it fails closed.
 */
export function createQueryExecutor(queryFn: MarketplaceQueryFn): MarketplaceExecutor {
  return {
    kind: 'query',
    async execute(payload, bounds) {
      const { sparql } = parseJsonPayload(payload);
      if (typeof sparql !== 'string' || sparql.length === 0) {
        throw new MarketplaceExecutionError('BAD_PAYLOAD', 'query payload needs a non-empty string `sparql`');
      }
      let outcome: Awaited<ReturnType<MarketplaceQueryFn>>;
      try {
        outcome = await queryFn(sparql);
      } catch (error) {
        throw new MarketplaceExecutionError(
          'EXECUTION_FAILED',
          `local query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const unitsServed = queryUnits(sparql, outcome.rowCount);
      if (unitsServed > bounds.maxUnits) {
        throw new MarketplaceExecutionError(
          'OVER_MAX_UNITS',
          `query meters ${unitsServed} units (${outcome.rowCount} rows), over the authorized maxUnits ${bounds.maxUnits}`,
        );
      }
      return {
        resultBytes: textEncoder.encode(JSON.stringify({ result: outcome.result })),
        unitsServed,
      };
    },
  };
}
