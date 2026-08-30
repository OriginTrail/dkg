import {
  compileRfc64SemanticReadRequestV2,
  decodeRfc64SemanticRecordStoreRowsV1,
  Rfc64SemanticReadManifestErrorV1,
  type DecodedRfc64SemanticRecordV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticStoreRowV1,
} from '@origintrail-official/dkg-core';

import {
  composeAbortSignals,
  raceStoreWorkAgainstAbort,
} from './abortable-store-work-lifecycle.js';
import {
  findTripleStoreCapability,
  type TripleStore,
} from './triple-store.js';
import {
  Rfc64SemanticReadCapabilityResultErrorV1,
  isRfc64SemanticReadCapabilityV1,
  type Rfc64SemanticReadCapabilityV1,
} from './rfc64-semantic-read-capability.js';

export const MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1 = 30_000;

export interface Rfc64SemanticReadRequestV1 {
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
}

export interface Rfc64SemanticReadOptionsV1 {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type Rfc64SemanticReadResultV1 =
  | {
      readonly kind: 'absent';
    }
  | {
      readonly kind: 'record';
      readonly decoded: DecodedRfc64SemanticRecordV1;
    };

export type Rfc64SemanticReadGatewayErrorCodeV1 =
  | 'rfc64-semantic-read-capability'
  | 'rfc64-semantic-read-request'
  | 'rfc64-semantic-read-options'
  | 'rfc64-semantic-read-result';

export class Rfc64SemanticReadGatewayErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SemanticReadGatewayErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SemanticReadGatewayErrorV1';
  }
}

/**
 * Narrow RFC-64 semantic read boundary. Consumers receive this gateway rather
 * than a generic SPARQL client; every dispatched query is recompiled from the
 * closed manifest immediately before execution.
 */
export class SyncSemanticStoreV1 {
  private readonly capability: Rfc64SemanticReadCapabilityV1;

  constructor(store: TripleStore) {
    const capability = findTripleStoreCapability(
      store,
      isRfc64SemanticReadCapabilityV1,
    );
    if (!capability) {
      fail(
        'rfc64-semantic-read-capability',
        'triple store has no certified RFC-64 semantic read capability',
      );
    }
    this.capability = capability;
  }

  async read(
    input: unknown,
    options: Rfc64SemanticReadOptionsV1,
  ): Promise<Rfc64SemanticReadResultV1> {
    let operation;
    try {
      operation = compileRfc64SemanticReadRequestV2(input);
    } catch (cause) {
      if (cause instanceof Rfc64SemanticReadManifestErrorV1) {
        fail('rfc64-semantic-read-request', cause.message, cause);
      }
      throw cause;
    }
    const readOptions = snapshotOptions(options);
    const deadline = new Rfc64SemanticReadDeadlineScope(readOptions);
    try {
      let capabilityResult;
      try {
        capabilityResult = await deadline.waitFor(() => this.capability.rfc64SemanticReadV1(
          operation,
          { signal: deadline.signal },
        ));
      } catch (cause) {
        if (cause instanceof Rfc64SemanticReadCapabilityResultErrorV1) {
          fail('rfc64-semantic-read-result', cause.message, cause);
        }
        throw cause;
      }
      const { rows } = snapshotCapabilityResult(capabilityResult, operation.resultVariables);
      if (rows.length === 0) {
        return Object.freeze({ kind: 'absent' });
      }
      const decoded = decodeRfc64SemanticRecordStoreRowsV1(rows, operation.coordinate);
      deadline.check();
      return Object.freeze({
        kind: 'record',
        decoded,
      });
    } finally {
      deadline.dispose();
    }
  }
}

function snapshotCapabilityResult(
  input: unknown,
  expectedVariables: readonly string[],
): Readonly<{ readonly rows: readonly Rfc64SemanticStoreRowV1[] }> {
  const result = snapshotExactRecord(
    input,
    ['rows', 'variables'],
    'RFC-64 semantic read capability result',
    'rfc64-semantic-read-result',
  );
  if (!Array.isArray(result.variables) || Object.getPrototypeOf(result.variables) !== Array.prototype) {
    fail('rfc64-semantic-read-result', 'semantic read result projection must be an ordinary Array');
  }
  const variableKeys = Reflect.ownKeys(result.variables);
  if (
    variableKeys.some((key) => typeof key !== 'string')
    || variableKeys.length !== result.variables.length + 1
    || !variableKeys.includes('length')
    || result.variables.length !== expectedVariables.length
  ) {
    fail('rfc64-semantic-read-result', 'semantic read returned the wrong result projection');
  }
  for (let index = 0; index < expectedVariables.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(result.variables, String(index));
    if (
      !descriptor?.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.value !== expectedVariables[index]
    ) {
      fail('rfc64-semantic-read-result', 'semantic read returned the wrong result projection');
    }
  }
  if (!Array.isArray(result.rows) || Object.getPrototypeOf(result.rows) !== Array.prototype) {
    fail('rfc64-semantic-read-result', 'semantic read rows must be an ordinary Array');
  }
  return Object.freeze({ rows: result.rows as readonly Rfc64SemanticStoreRowV1[] });
}

function snapshotOptions(input: unknown): Rfc64SemanticReadOptionsV1 {
  const options = snapshotExactRecord(
    input,
    isRecordWithOwnKey(input, 'signal') ? ['signal', 'timeoutMs'] : ['timeoutMs'],
    'RFC-64 semantic read options',
    'rfc64-semantic-read-options',
  );
  if (
    typeof options.timeoutMs !== 'number'
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1
  ) {
    fail(
      'rfc64-semantic-read-options',
      `timeoutMs must be an integer from 1 to ${MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1}`,
    );
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    fail('rfc64-semantic-read-options', 'signal must be an AbortSignal');
  }
  return Object.freeze({
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }) as Rfc64SemanticReadOptionsV1;
}

function snapshotExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  code: Rfc64SemanticReadGatewayErrorCodeV1,
): Readonly<Record<string, unknown>> {
  if (
    input === null
    || typeof input !== 'object'
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    fail(code, `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label} must use enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function isRecordWithOwnKey(input: unknown, key: string): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, key);
}

class Rfc64SemanticReadDeadlineScope {
  private readonly deadlineAt: number;
  private readonly signalScope: ReturnType<typeof composeAbortSignals>;

  constructor(options: Rfc64SemanticReadOptionsV1) {
    this.deadlineAt = performance.now() + options.timeoutMs;
    this.signalScope = composeAbortSignals(
      options.signal,
      AbortSignal.timeout(options.timeoutMs),
    );
  }

  get signal(): AbortSignal {
    return this.signalScope.signal as AbortSignal;
  }

  check(): void {
    this.signal.throwIfAborted();
    if (performance.now() >= this.deadlineAt) {
      throw new DOMException('RFC-64 semantic read deadline exceeded', 'TimeoutError');
    }
  }

  async waitFor<T>(start: () => Promise<T>): Promise<T> {
    this.check();
    const operation = start();
    try {
      const result = await raceStoreWorkAgainstAbort(operation, this.signal);
      this.check();
      return result;
    } catch (cause) {
      this.check();
      throw cause;
    }
  }

  dispose(): void {
    this.signalScope.dispose();
  }
}

function fail(
  code: Rfc64SemanticReadGatewayErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SemanticReadGatewayErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
