// SPDX-License-Identifier: Apache-2.0
import type { NamedKaVmPublishResult } from './named-ka-vm-publish-result.js';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';

export type ConfirmedNamedKaVmPublication = NamedKaVmPublishResult & { readonly status: 'confirmed' };
export interface ConfirmedNamedKaVmLifecycleRecovery extends ConfirmedNamedKaVmLifecycleInput {
  readonly action: 'recover_confirmed_publication';
  readonly publicationRetrySafe: false;
}

/** The fields a foreign recovery error certifies for response projection. */
export interface ConfirmedNamedKaVmPublicationView {
  readonly status: 'confirmed';
  readonly kaId: bigint;
  readonly ual: string;
  readonly assertionUri: string;
  readonly merkleRoot: Uint8Array;
  readonly seal: { readonly authorAddress: string };
  readonly onChainResult?: {
    readonly txHash: string;
    readonly blockNumber: number;
    /** Passed through as receipt evidence; no richer cost model is certified. */
    readonly convictionCostCovered?: unknown;
  };
  readonly v10ACKs?: readonly { readonly peerId: string }[];
  readonly lifecycleRepairPending?: boolean;
  readonly contextGraphError?: string;
  readonly authorAddress?: string;
  readonly kas?: readonly unknown[];
}
export interface ConfirmedNamedKaVmLifecycleRecoveryView {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly publishedUal: string;
  readonly merkleRoot: string;
  readonly assertionVersion: string;
  readonly action: 'recover_confirmed_publication';
  readonly publicationRetrySafe: false;
}
/** A structural boundary is distinct from the producer's complete receipt and class aliases. */
export interface ConfirmedNamedKaVmLifecycleRecoveryErrorPayload {
  readonly code: 'KA_VM_LIFECYCLE_REPAIR_REQUIRED';
  readonly confirmedPublication: ConfirmedNamedKaVmPublicationView;
  readonly lifecycleRecovery: ConfirmedNamedKaVmLifecycleRecoveryView;
}

/** Confirmation survived, but the local write-ahead repair could not be admitted. */
export class ConfirmedNamedKaVmLifecycleRecoveryError extends Error implements ConfirmedNamedKaVmLifecycleRecoveryErrorPayload {
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

type ContractValidators<T> = { [K in keyof T]-?: (value: unknown) => value is T[K] };
function matchesContract<T>(value: unknown, fields: ContractValidators<T>): value is T {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(fields).every(key => fields[key as keyof T](Reflect.get(value, key)));
}
const string = (value: unknown): value is string => typeof value === 'string';
const optional = <T>(validate: (value: unknown) => value is T) =>
  (value: unknown): value is T | undefined => value === undefined || validate(value);
const publicationFields: ContractValidators<ConfirmedNamedKaVmPublicationView> = {
  status: (value): value is 'confirmed' => value === 'confirmed',
  kaId: (value): value is bigint => typeof value === 'bigint',
  ual: string, assertionUri: string,
  merkleRoot: (value): value is Uint8Array => value instanceof Uint8Array,
  seal: (value): value is ConfirmedNamedKaVmPublicationView['seal'] => matchesContract(value, { authorAddress: string }),
  onChainResult: optional((value): value is NonNullable<ConfirmedNamedKaVmPublicationView['onChainResult']> =>
    matchesContract(value, { txHash: string, blockNumber: (block): block is number => typeof block === 'number' && Number.isSafeInteger(block) && block >= 0,
      convictionCostCovered: (_cost): _cost is unknown => true })),
  v10ACKs: optional((value): value is NonNullable<ConfirmedNamedKaVmPublicationView['v10ACKs']> =>
    Array.isArray(value) && value.every(ack => matchesContract(ack, { peerId: string }))),
  lifecycleRepairPending: optional((value): value is boolean => typeof value === 'boolean'),
  contextGraphError: optional(string), authorAddress: optional(string),
  kas: optional((value): value is readonly unknown[] => Array.isArray(value)),
};
const recoveryFields: ContractValidators<ConfirmedNamedKaVmLifecycleRecoveryView> = {
  contextGraphId: string, agentAddress: string, name: string, publishedUal: string, merkleRoot: string, assertionVersion: string,
  action: (value): value is 'recover_confirmed_publication' => value === 'recover_confirmed_publication',
  publicationRetrySafe: (value): value is false => value === false,
};

/** Recognize package-copy errors without claiming unvalidated producer fields. */
export function isConfirmedNamedKaVmLifecycleRecoveryError(
  error: unknown,
): error is Error & ConfirmedNamedKaVmLifecycleRecoveryErrorPayload {
  try {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'KA_VM_LIFECYCLE_REPAIR_REQUIRED') return false;
    const publication: unknown = Reflect.get(error, 'confirmedPublication'), recovery: unknown = Reflect.get(error, 'lifecycleRecovery');
    return matchesContract(publication, publicationFields) && matchesContract(recovery, recoveryFields)
      && recovery.publishedUal === publication.ual && !('tentative' in recovery);
  } catch {
    // A foreign structural error may expose throwing accessors; it certifies no payload.
    return false;
  }
}
