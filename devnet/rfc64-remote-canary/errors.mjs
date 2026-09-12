// SPDX-License-Identifier: Apache-2.0

export class RemoteCanaryError extends Error {
  /**
   * @param {string} code
   * @param {string} category
   * @param {ErrorOptions & { phase?: string }} [options]
   */
  constructor(code, category, options = {}) {
    super(code, options);
    this.name = 'RemoteCanaryError';
    this.code = code;
    this.category = category;
    if (options.phase !== undefined) this.phase = options.phase;
  }
}

/** @param {string} code @param {string} category @param {unknown} [cause] */
export function failure(code, category, cause) {
  return new RemoteCanaryError(code, category, cause === undefined ? {} : { cause });
}

/**
 * Attach the owning certification stage without changing the low-level error code/category.
 * @template Result
 * @param {string} phase
 * @param {() => Result} operation
 * @returns {Result}
 */
export function runPhaseV1(phase, operation) {
  /** @param {unknown} error */
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
    return /** @type {Result} */ (isPromiseLike(result)
      ? Promise.resolve(result).catch((error) => { throw attachPhase(error); })
      : result);
  } catch (error) {
    throw attachPhase(error);
  }
}

/** @param {unknown} value @returns {value is PromiseLike<unknown>} */
function isPromiseLike(value) {
  return value !== null
    && typeof value === 'object'
    && typeof /** @type {{ then?: unknown }} */ (value).then === 'function';
}

/** @param {string} code @returns {never} */
export function invalid(code) {
  throw failure(code, 'configuration');
}
