// SPDX-License-Identifier: Apache-2.0
import type { AssertionSeal } from '@origintrail-official/dkg-core';
import type { PublishResult } from '@origintrail-official/dkg-publisher';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';

export type ConfirmedNamedKaVmPublication = PublishResult & {
  readonly status: 'confirmed';
  readonly assertionUri: string;
  readonly seal: AssertionSeal;
};
export interface ConfirmedNamedKaVmLifecycleRecovery extends ConfirmedNamedKaVmLifecycleInput {
  readonly action: 'recover_confirmed_publication';
  readonly publicationRetrySafe: false;
}

/** Confirmation survived, but the local write-ahead repair could not be admitted. */
export class ConfirmedNamedKaVmLifecycleRecoveryError extends Error {
  readonly code = 'KA_VM_LIFECYCLE_REPAIR_REQUIRED';
  readonly publishedUal: string;
  readonly merkleRoot: string;
  readonly assertionVersion: string;
  readonly lifecycleRecovery: ConfirmedNamedKaVmLifecycleRecovery;

  constructor(
    readonly confirmedPublication: ConfirmedNamedKaVmPublication,
    input: ConfirmedNamedKaVmLifecycleInput,
    cause: unknown,
  ) {
    super(`Confirmed publish requires lifecycle recovery: ${String(cause)}`, { cause });
    this.name = 'ConfirmedNamedKaVmLifecycleRecoveryError';
    this.publishedUal = input.publishedUal;
    this.merkleRoot = input.merkleRoot;
    this.assertionVersion = input.assertionVersion;
    this.lifecycleRecovery = Object.freeze({ ...input, action: 'recover_confirmed_publication', publicationRetrySafe: false });
  }
}

/** Closed structural guard shared by the producer and its HTTP consumer. */
export function isConfirmedNamedKaVmLifecycleRecoveryError(error: unknown): error is ConfirmedNamedKaVmLifecycleRecoveryError {
  if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'KA_VM_LIFECYCLE_REPAIR_REQUIRED') return false;
  const publication = Reflect.get(error, 'confirmedPublication'), recovery = Reflect.get(error, 'lifecycleRecovery');
  if (publication === null || typeof publication !== 'object' || recovery === null || typeof recovery !== 'object') return false;
  return Reflect.get(publication, 'status') === 'confirmed'
    && typeof Reflect.get(publication, 'ual') === 'string'
    && typeof Reflect.get(publication, 'assertionUri') === 'string'
    && Reflect.get(publication, 'merkleRoot') instanceof Uint8Array
    && Reflect.get(publication, 'seal') !== null && typeof Reflect.get(publication, 'seal') === 'object'
    && Reflect.get(recovery, 'action') === 'recover_confirmed_publication'
    && Reflect.get(recovery, 'publicationRetrySafe') === false
    && ['contextGraphId', 'agentAddress', 'name', 'publishedUal', 'merkleRoot', 'assertionVersion']
      .every(field => typeof Reflect.get(recovery, field) === 'string')
    && Reflect.get(recovery, 'publishedUal') === Reflect.get(publication, 'ual')
    && !('tentative' in recovery);
}
