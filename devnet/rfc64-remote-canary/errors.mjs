// SPDX-License-Identifier: Apache-2.0

export class RemoteCanaryError extends Error {
  constructor(code, category, options = {}) {
    super(code, options);
    this.name = 'RemoteCanaryError';
    this.code = code;
    this.category = category;
    if (options.phase !== undefined) this.phase = options.phase;
  }
}

export function failure(code, category, cause) {
  return new RemoteCanaryError(code, category, cause === undefined ? {} : { cause });
}

/** Attach the owning certification stage without changing the low-level error code/category. */
export function runPhaseV1(phase, operation) {
  const attachPhase = (error) => {
    if (error instanceof RemoteCanaryError) {
      return new RemoteCanaryError(error.code, error.category, {
        cause: error.cause ?? error,
        phase,
      });
    }
    return new RemoteCanaryError('unexpected-execution-failure', 'programming', {
      cause: error,
      phase,
    });
  };
  try {
    const result = operation();
    return result !== null && typeof result?.then === 'function'
      ? Promise.resolve(result).catch((error) => { throw attachPhase(error); })
      : result;
  } catch (error) {
    throw attachPhase(error);
  }
}

export function invalid(code) {
  throw failure(code, 'configuration');
}
