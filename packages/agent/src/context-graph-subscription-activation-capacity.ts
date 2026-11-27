// SPDX-License-Identifier: Apache-2.0

/** Recovery must hand this row to rolling activation without installing it. */
export class SubscriptionActivationCapacityError extends Error {
  constructor() {
    super('Persisted subscription activation cap is full');
    this.name = 'SubscriptionActivationCapacityError';
  }
}
