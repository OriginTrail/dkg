import { ReconciliationError } from './errors.js';

export interface ReconciliationClock {
  now(): number;
}

export interface ReconciliationLimits {
  maximumSymbols: number;
  maximumDecodedDifference: number;
  maximumOperations: number;
  maximumMemoryBytes: number;
  maximumElapsedMs: number;
}

export interface ReconciliationUsage {
  symbols: number;
  decodedIds: number;
  operations: number;
  accountedMemoryBytes: number;
  peakAccountedMemoryBytes: number;
  elapsedMs: number;
}

export const DEFAULT_RECONCILIATION_LIMITS: Readonly<ReconciliationLimits> = Object.freeze({
  maximumSymbols: 1_048_576,
  maximumDecodedDifference: 250_000,
  maximumOperations: 1_000_000_000,
  maximumMemoryBytes: 512 * 1024 * 1024,
  maximumElapsedMs: 120_000
});

const SYSTEM_CLOCK: ReconciliationClock = {
  now: () => globalThis.performance.now()
};

export function validateReconciliationLimits(limits: ReconciliationLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReconciliationError('INVALID_CONFIGURATION', `${name} must be a positive safe integer`, { name, value });
    }
  }
}

export class ReconciliationBudget {
  readonly #startedAt: number;
  #symbols = 0;
  #decodedIds = 0;
  #operations = 0;
  #accountedMemoryBytes = 0;
  #peakAccountedMemoryBytes = 0;

  constructor(
    readonly limits: Readonly<ReconciliationLimits> = DEFAULT_RECONCILIATION_LIMITS,
    readonly clock: ReconciliationClock = SYSTEM_CLOCK
  ) {
    validateReconciliationLimits(limits);
    this.#startedAt = clock.now();
  }

  acceptSymbol(): void {
    this.#symbols += 1;
    if (this.#symbols > this.limits.maximumSymbols) {
      throw new ReconciliationError('SYMBOL_LIMIT', 'reconciliation symbol limit exceeded', {
        limit: this.limits.maximumSymbols
      });
    }
    this.checkElapsed();
  }

  acceptDecodedId(): void {
    this.#decodedIds += 1;
    if (this.#decodedIds > this.limits.maximumDecodedDifference) {
      throw new ReconciliationError('DECODED_DIFFERENCE_LIMIT', 'decoded difference limit exceeded', {
        limit: this.limits.maximumDecodedDifference
      });
    }
    this.checkElapsed();
  }

  chargeOperations(count = 1): void {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'operation charge must be a positive safe integer');
    }
    this.#operations += count;
    if (this.#operations > this.limits.maximumOperations) {
      throw new ReconciliationError('OPERATION_LIMIT', 'reconciliation operation limit exceeded', {
        limit: this.limits.maximumOperations
      });
    }
    this.checkElapsed();
  }

  reserveMemory(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'memory reservation must be a positive safe integer');
    }
    this.#accountedMemoryBytes += bytes;
    this.#peakAccountedMemoryBytes = Math.max(this.#peakAccountedMemoryBytes, this.#accountedMemoryBytes);
    if (this.#accountedMemoryBytes > this.limits.maximumMemoryBytes) {
      throw new ReconciliationError('MEMORY_LIMIT', 'reconciliation memory limit exceeded', {
        limit: this.limits.maximumMemoryBytes
      });
    }
    this.checkElapsed();
  }

  releaseMemory(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.#accountedMemoryBytes) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'invalid memory release');
    }
    this.#accountedMemoryBytes -= bytes;
  }

  checkElapsed(): void {
    if (this.clock.now() - this.#startedAt > this.limits.maximumElapsedMs) {
      throw new ReconciliationError('ELAPSED_TIME_LIMIT', 'reconciliation elapsed-time limit exceeded', {
        limit: this.limits.maximumElapsedMs
      });
    }
  }

  snapshot(): ReconciliationUsage {
    return Object.freeze({
      symbols: this.#symbols,
      decodedIds: this.#decodedIds,
      operations: this.#operations,
      accountedMemoryBytes: this.#accountedMemoryBytes,
      peakAccountedMemoryBytes: this.#peakAccountedMemoryBytes,
      elapsedMs: Math.max(0, this.clock.now() - this.#startedAt)
    });
  }
}
