// SPDX-License-Identifier: Apache-2.0

/**
 * Nominal capability issued while one context graph's admission lane is held.
 * The brand is intentionally private to this module: callers can pass tokens
 * around, but cannot construct one without an unsafe type assertion. Runtime
 * validation below rejects asserted/forged objects as well.
 */
const contextGraphJoinAdmissionLockTokenBrand: unique symbol = Symbol(
  'ContextGraphJoinAdmissionLockToken',
);

export type ContextGraphJoinAdmissionLockToken = Readonly<{
  [contextGraphJoinAdmissionLockTokenBrand]: true;
}>;

/**
 * Process-local, per-context-graph admission serializer.
 *
 * Tokens are registered in this manager's private WeakMap only for the
 * lifetime of the callback. Consequently a token from another manager, for a
 * different context graph, or retained after the callback returns is invalid.
 */
export class ContextGraphJoinAdmissionLockManager {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly liveTokens = new WeakMap<object, string>();

  async withLock<T>(
    contextGraphId: string,
    operation: (token: ContextGraphJoinAdmissionLockToken) => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(contextGraphId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    this.queues.set(contextGraphId, current);
    await previous.catch(() => {});

    const token = Object.freeze({
      [contextGraphJoinAdmissionLockTokenBrand]: true,
    }) as ContextGraphJoinAdmissionLockToken;
    this.liveTokens.set(token, contextGraphId);
    try {
      return await operation(token);
    } finally {
      this.liveTokens.delete(token);
      release();
      if (this.queues.get(contextGraphId) === current) {
        this.queues.delete(contextGraphId);
      }
    }
  }

  assertHeld(
    contextGraphId: string,
    token: ContextGraphJoinAdmissionLockToken | undefined,
  ): void {
    if (
      token === undefined
      || typeof token !== 'object'
      || token === null
      || this.liveTokens.get(token) !== contextGraphId
    ) {
      throw new Error(
        `Context graph admission mutation for "${contextGraphId}" requires its live admission-lock token.`,
      );
    }
  }
}
