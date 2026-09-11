// SPDX-License-Identifier: Apache-2.0

export class RemoteCanaryError extends Error {
  constructor(code, phase, options = {}) {
    super(code, options);
    this.name = 'RemoteCanaryError';
    this.code = code;
    this.phase = phase;
  }
}

export function failure(code, phase, cause) {
  return new RemoteCanaryError(code, phase, cause === undefined ? {} : { cause });
}

export function invalid(code) {
  throw failure(code, 'config');
}
