// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';

import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

const RUNTIMES_V1 = new WeakMap<object, Rfc64SerializedScopeRuntimeV1>();

function runtimeV1(owner: object): Rfc64SerializedScopeRuntimeV1 {
  let runtime = RUNTIMES_V1.get(owner);
  if (runtime === undefined) {
    runtime = new Rfc64SerializedScopeRuntimeV1('RFC-64 catalog mutation aborted');
    RUNTIMES_V1.set(owner, runtime);
  }
  return runtime;
}

/** Serialize local authoring and remote receiver commits for one exact catalog scope. */
export function runRfc64CatalogMutationExclusiveV1<T>(
  owner: object,
  scope: Readonly<AuthorCatalogScopeV1>,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = `${computeAuthorCatalogScopeDigestV1(scope)}\n${scope.authorAddress}`;
  return runtimeV1(owner).run(key, operation, signal);
}
