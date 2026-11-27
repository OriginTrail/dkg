// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphJoinAdmissionLockToken } from './context-graph-join-admission-lock.js';

const preparedContextGraphMembershipMutationBrand: unique symbol = Symbol(
  'PreparedContextGraphMembershipMutation',
);

/**
 * Opaque, single-use membership write prepared while a per-CG admission lock
 * is live. The plan is deliberately only a phantom type here: consumers must
 * return to the store that issued the capability to recover it.
 */
export type PreparedContextGraphMembershipMutation<TPlan> = Readonly<{
  [preparedContextGraphMembershipMutationBrand]: TPlan;
}>;

interface PreparedMutationEntry {
  admissionLockToken: ContextGraphJoinAdmissionLockToken;
  contextGraphId: string;
  plan: unknown;
}

/**
 * Instance-local registry for prepared membership mutations. Capabilities are
 * bound to the exact lock token and context graph, and are consumed once.
 */
export class ContextGraphMembershipMutationStore {
  private readonly prepared = new WeakMap<object, PreparedMutationEntry>();

  prepare<TPlan>(
    admissionLockToken: ContextGraphJoinAdmissionLockToken,
    contextGraphId: string,
    plan: TPlan,
  ): PreparedContextGraphMembershipMutation<TPlan> {
    const capability = Object.freeze({
      [preparedContextGraphMembershipMutationBrand]: true,
    }) as unknown as PreparedContextGraphMembershipMutation<TPlan>;
    this.prepared.set(capability, { admissionLockToken, contextGraphId, plan });
    return capability;
  }

  consume<TPlan>(
    admissionLockToken: ContextGraphJoinAdmissionLockToken,
    contextGraphId: string,
    capability: PreparedContextGraphMembershipMutation<TPlan>,
  ): TPlan {
    const entry = this.prepared.get(capability);
    if (
      !entry
      || entry.admissionLockToken !== admissionLockToken
      || entry.contextGraphId !== contextGraphId
    ) {
      throw new Error(
        `Context graph membership mutation for "${contextGraphId}" requires its live prepared capability.`,
      );
    }
    this.prepared.delete(capability);
    return entry.plan as TPlan;
  }
}
