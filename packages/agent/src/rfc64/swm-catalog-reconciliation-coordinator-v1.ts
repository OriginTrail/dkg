import type {
  ContextGraphIdV1,
  EvmAddressV1,
} from '@origintrail-official/dkg-core';

export interface Rfc64SwmCatalogReconciliationScopeV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
}

export function rfc64SwmCatalogReconciliationScopeKeyV1(
  scope: Readonly<Rfc64SwmCatalogReconciliationScopeV1>,
): string {
  return JSON.stringify([scope.contextGraphId, scope.authorAddress.toLowerCase()]);
}

interface ScopeReconciliationStateV1 {
  dirty: boolean;
  readonly scope: Readonly<Rfc64SwmCatalogReconciliationScopeV1>;
  completion: Promise<void>;
}

/** Coalesces exact catalog projection onto the latest durable author inventory. */
export class Rfc64SwmCatalogReconciliationCoordinatorV1 {
  readonly #activeScopes = new Map<string, ScopeReconciliationStateV1>();
  readonly #reconcileScope: (
    scope: Readonly<Rfc64SwmCatalogReconciliationScopeV1>,
  ) => Promise<void>;

  constructor(
    reconcileScope: (
      scope: Readonly<Rfc64SwmCatalogReconciliationScopeV1>,
    ) => Promise<void>,
  ) {
    this.#reconcileScope = reconcileScope;
  }

  /**
   * A mutation arriving during a pass marks the scope dirty and causes exactly
   * one latest-state follow-up. Callers for one active scope share completion.
   */
  request(
    requestedScope: Readonly<Rfc64SwmCatalogReconciliationScopeV1>,
  ): Promise<void> {
    const scope = Object.freeze({
      contextGraphId: requestedScope.contextGraphId,
      authorAddress: requestedScope.authorAddress.toLowerCase() as EvmAddressV1,
    });
    const scopeKey = rfc64SwmCatalogReconciliationScopeKeyV1(scope);
    const active = this.#activeScopes.get(scopeKey);
    if (active !== undefined) {
      active.dirty = true;
      return active.completion;
    }

    const state: ScopeReconciliationStateV1 = {
      dirty: true,
      scope,
      completion: Promise.resolve(),
    };
    const completion = Promise.resolve().then(
      () => this.run(scopeKey, state),
    );
    state.completion = completion;
    this.#activeScopes.set(scopeKey, state);
    return completion;
  }

  private async run(
    scopeKey: string,
    state: ScopeReconciliationStateV1,
  ): Promise<void> {
    try {
      while (state.dirty) {
        state.dirty = false;
        try {
          await this.#reconcileScope(state.scope);
        } catch (cause) {
          // A newer mutation is a bounded retry request. Without one, surface
          // the failure for the durable restart/periodic repair lane.
          if (!state.dirty) throw cause;
        }
      }
    } finally {
      if (this.#activeScopes.get(scopeKey) === state) {
        this.#activeScopes.delete(scopeKey);
      }
    }
  }
}
