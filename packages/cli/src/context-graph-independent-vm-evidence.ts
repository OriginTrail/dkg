// SPDX-License-Identifier: Apache-2.0

/** A finalized zero-inventory proof contributes durable evidence only. */
export function registeredPrivateEmptyVmEvidence(input: Readonly<{
  proven: boolean;
  isPrivate: boolean;
  registration?: 'unregistered';
}>): boolean {
  return input.proven && input.isPrivate && input.registration !== 'unregistered';
}
